/**
 * #6678 — the five panels #6577 fixed still painted `this.content` themselves.
 * Routing their SUCCESS writes through `Panel.setContentNodes()` /
 * `Panel.setTrustedContent()` is what #6678 finishes, and this file is its proof.
 *
 * The migration is deliberately RUNG-NEUTRAL. Every one of these panels already
 * called `clearErrorState()` on its success path (#6587, `f2b0ef683`), so the
 * chip / countdown / backoff behaviour pinned by
 * `tests/dom/panel-error-latch-6577.test.mts` is unchanged by this migration.
 * That file must stay green throughout; it is not the proof of this change.
 *
 * What the sanctioned helpers ADD over a raw `replaceChildren(this.content, …)`
 * preceded by `clearErrorState()` is exactly three things
 * (`Panel.ts:1287` / `:1298`):
 *   1. a `_locked` bail BEFORE the write,
 *   2. `cancelPendingContentWrite()`,
 *   3. `invalidateCommittedHtml()`.
 *
 * (2) and (3) are unobservable from outside the base class for these five: none
 * of them calls `setSafeContent`, so no debounced write can be pending and
 * `lastCommittedHtml` is never consulted. (1) is observable at every call site
 * and is the one with a user-visible failure mode — a success render landing on
 * a locked panel paints content straight over the upgrade CTA. That is what
 * every case below drives.
 *
 * PER CALL SITE, not once on the base class. `tests/panel-content-write-guard.test.mts`
 * already asserts `Panel.setContentNodes` bails on `_locked`, so a mutation of
 * the bail itself dies there. What that assertion CANNOT see is one panel left
 * behind on `replaceChildren` — which is precisely the state #6678 exists to
 * end. So every migrated write is exercised separately, the same argument
 * `panel-error-latch-6577.test.mts` makes for `clearErrorState()`.
 * See docs/solutions/conventions/mutate-each-call-site-a-global-mutant-hides-per-site-holes.md
 *
 * LATENT, like the #6577 cases, and for the same kind of reason. None of these
 * five keys is in `WEB_PREMIUM_PANELS` (`src/app/panel-layout.ts:126`), so
 * `updatePanelGating` resolves `PanelGateReason.NONE` for them and never gates
 * them today. But `showLocked()` is public API on every `Panel`, and the
 * lazy-registration path (`panel-layout.ts:3396`) locks whatever it is handed.
 * These cases pin the contract at each call site for the day one of these
 * panels becomes premium; they are not evidence a live paywall hole was closed.
 *
 * NON-VACUITY: every case first drives the SAME success write on an UNLOCKED
 * panel and asserts the panel's own markup landed. Without that, a panel whose
 * success render silently no-ops would satisfy the locked assertion for entirely
 * the wrong reason.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const {
  mockFetchTopicIntelligence,
  mockFetchTopicTimeline,
  mockRenderGivingPanelContent,
  mockAvailableGivingTabs,
} = vi.hoisted(() => ({
  mockFetchTopicIntelligence: vi.fn(),
  mockFetchTopicTimeline: vi.fn(),
  mockRenderGivingPanelContent: vi.fn(),
  mockAvailableGivingTabs: vi.fn(),
}));

vi.mock('@/services/gdelt-intel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/gdelt-intel')>(),
  fetchTopicIntelligence: mockFetchTopicIntelligence,
  fetchTopicTimeline: mockFetchTopicTimeline,
}));

vi.mock('@/components/giving-renderer', () => ({
  availableGivingTabs: mockAvailableGivingTabs,
  renderGivingPanelContent: mockRenderGivingPanelContent,
}));

import { DefensePatentsPanel } from '@/components/DefensePatentsPanel';
import { GdeltIntelPanel } from '@/components/GdeltIntelPanel';
import { GivingPanel } from '@/components/GivingPanel';
import { ServiceStatusPanel } from '@/components/ServiceStatusPanel';
import { TechEventsPanel } from '@/components/TechEventsPanel';

/** Base-class state these tests reach into. */
interface PanelInternals {
  element: HTMLElement;
  content: HTMLElement;
  retryAttempt: number;
}

/** Per-panel fields the render() call sites branch on. */
interface RenderFlags {
  loading: boolean;
  error: string | null;
}

function internals(panel: object): PanelInternals {
  return panel as unknown as PanelInternals;
}

function flags(panel: object): RenderFlags {
  return panel as unknown as RenderFlags;
}

function mount(panel: object): void {
  document.body.appendChild(internals(panel).element);
}

function lockedCta(panel: object): Element | null {
  return internals(panel).content.querySelector('.panel-locked-state');
}

/** The countdown line rendered by `showError`, e.g. "Retrying (15s)". */
function countdownText(panel: object): string | null {
  return internals(panel).content.querySelector('.panel-error-countdown')?.textContent ?? null;
}

/** Repeated successful public updates must remain visible without an account gate. */
async function expectSuccessWriteRespectsLock(
  panel: object,
  driveSuccess: () => void | Promise<void>,
  successSelector: string,
): Promise<void> {
  // Non-vacuity: unlocked, this write really does paint the panel's content.
  await driveSuccess();
  expect(internals(panel).content.querySelector(successSelector)).not.toBeNull();

  await driveSuccess();
  expect(lockedCta(panel)).toBeNull();
  expect(internals(panel).content.querySelector(successSelector)).not.toBeNull();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ServiceStatusPanel', () => {
  it('repeatedly paints the public service list without an account lock', async () => {
    const panel = new ServiceStatusPanel();
    mount(panel);

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
      '.service-status-summary',
    );

    panel.destroy();
  });
});

describe('TechEventsPanel', () => {
  it('repeatedly paints public events without an account lock', async () => {
    vi.spyOn(
      TechEventsPanel.prototype as unknown as { fetchEvents(): Promise<void> },
      'fetchEvents',
    ).mockResolvedValue(undefined);

    const panel = new TechEventsPanel('tech-events');
    mount(panel);

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
      '.tech-events-panel',
    );

    panel.destroy();
  });
});

describe('DefensePatentsPanel', () => {
  it('repeatedly paints public patents without an account lock', async () => {
    vi.spyOn(
      DefensePatentsPanel.prototype as unknown as { fetchPatents(): Promise<void> },
      'fetchPatents',
    ).mockResolvedValue(undefined);

    const panel = new DefensePatentsPanel();
    mount(panel);

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
      '.defense-patents-panel',
    );

    panel.destroy();
  });
});

/**
 * `renderArticles` carries BOTH of GdeltIntelPanel's migrated writes — the
 * empty-state branch and the article-list branch — and the ratchet counted them
 * as two. Each needs its own case, or migrating one and leaving the other would
 * still show green.
 */
describe('GdeltIntelPanel', () => {
  async function newPanel(): Promise<GdeltIntelPanel> {
    mockFetchTopicIntelligence.mockResolvedValue({ articles: [], fetchedAt: new Date() });
    mockFetchTopicTimeline.mockResolvedValue(null);
    const panel = new GdeltIntelPanel();
    mount(panel);
    await vi.advanceTimersByTimeAsync(0);
    return panel;
  }

  it('repeatedly paints public articles without an account lock', async () => {
    const panel = await newPanel();
    const articles = [{
      url: 'https://example.com/story',
      title: 'Story',
      source: 'example.com',
      date: new Date().toISOString(),
      tone: 0,
    }];

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        (panel as unknown as { renderArticles(a: unknown[]): void }).renderArticles(articles);
      },
      '.gdelt-intel-articles',
    );

    panel.destroy();
  });

  it('repeatedly paints the public empty state without an account lock', async () => {
    const panel = await newPanel();

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        (panel as unknown as { renderArticles(a: unknown[]): void }).renderArticles([]);
      },
      '.empty-state',
    );

    panel.destroy();
  });
});

/**
 * The hazard #6678 CREATES, and the reason these two cases live here rather
 * than beside the success cases above.
 *
 * After this migration, ServiceStatus / TechEvents / DefensePatents each have
 * exactly ONE `replaceChildren(this.content, …)` left, and it is the loading
 * branch — so their ratchet entries read `x1`. The inventory's own rule ("a pair
 * that shrank or vanished MUST be updated here") reads like an invitation to
 * drive that last one to zero. Doing so would route a LOADING render through
 * `setContentNodes`, whose `clearErrorState()` resets `retryAttempt`, and every
 * retry would re-arm at the 15s floor instead of climbing toward the 180s cap.
 *
 * `tests/dom/panel-error-latch-6577.test.mts` already pins this — but only for
 * TechEventsPanel, and that file says so itself: its loading block is "a
 * base-class contract test riding on a convenient subclass, not a per-call-site
 * test". Before #6678 that was proportionate. Now that the loading branch is the
 * only write left in all three, the other two need their own case, or migrating
 * ServiceStatusPanel's or DefensePatentsPanel's loading branch ships green.
 */
describe('loading branches keep the backoff rung after the success migration', () => {
  /** Drive the real error site once: rung 0 is consumed, `retryAttempt` becomes 1. */
  function driveFirstFailure(panel: object): void {
    flags(panel).loading = false;
    flags(panel).error = 'boom';
    (panel as unknown as { render(): void }).render();
    // Non-vacuity: prove we really are at rung 1 before the loading render, so a
    // later "(30s)" cannot be an accident of the panel never having failed.
    expect(countdownText(panel)).toMatch(/\(15s\)/);
    expect(internals(panel).retryAttempt).toBe(1);
  }

  /** Drive the real error site again; the countdown reports the rung it re-entered at. */
  function driveSecondFailure(panel: object): string | null {
    flags(panel).loading = false;
    flags(panel).error = 'boom';
    (panel as unknown as { render(): void }).render();
    return countdownText(panel);
  }

  /**
   * `loadingSelector` is non-vacuity, not decoration: without it, DELETING the
   * loading branch outright leaves both cases below green — the rung would
   * survive a render that painted nothing at all, which is not the invariant.
   */
  function driveLoading(panel: object, loadingSelector: string): void {
    flags(panel).loading = true;
    (panel as unknown as { render(): void }).render();
    expect(internals(panel).content.querySelector(loadingSelector)).not.toBeNull();
  }

  it('ServiceStatusPanel keeps the rung across its loading render', () => {
    const panel = new ServiceStatusPanel();
    mount(panel);

    driveFirstFailure(panel);
    driveLoading(panel, '.service-status-loading');

    // 30s, not 15s: the loading render must not have reset the backoff.
    expect(driveSecondFailure(panel)).toMatch(/\(30s\)/);

    panel.destroy();
  });

  it('DefensePatentsPanel keeps the rung across its loading render', () => {
    vi.spyOn(
      DefensePatentsPanel.prototype as unknown as { fetchPatents(): Promise<void> },
      'fetchPatents',
    ).mockResolvedValue(undefined);

    const panel = new DefensePatentsPanel();
    mount(panel);

    driveFirstFailure(panel);
    driveLoading(panel, '.defense-patents-loading');

    expect(driveSecondFailure(panel)).toMatch(/\(30s\)/);

    panel.destroy();
  });
});

/**
 * GivingPanel is the `setTrustedContent` case — it builds its own markup string
 * through `giving-renderer` rather than DOM nodes, so it is the only one of the
 * five that cannot use `setContentNodes`.
 */
describe('GivingPanel', () => {
  it('repeatedly paints the public giving summary without an account lock', async () => {
    mockAvailableGivingTabs.mockReturnValue(['platforms']);
    mockRenderGivingPanelContent.mockReturnValue('<div class="giving-body"></div>');

    const panel = new GivingPanel();
    mount(panel);

    await expectSuccessWriteRespectsLock(
      panel,
      () => {
        panel.setData({
          materializedAt: new Date(Date.now() - 60_000).toISOString(),
          platforms: [{ platform: 'Platform 1' }],
        } as unknown as Parameters<GivingPanel['setData']>[0]);
      },
      '.giving-body',
    );

    panel.destroy();
  });
});
