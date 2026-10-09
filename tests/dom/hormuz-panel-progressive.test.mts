import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HormuzPanel } from '@/components/HormuzPanel';
import type { HormuzTrackerData } from '@/services/hormuz-tracker';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/services/hormuz-tracker', () => ({ fetchHormuzTracker: transport.fetch }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

const data: HormuzTrackerData = {
  fetchedAt: 1, updatedDate: '2026-10-01', title: 'Public tracker',
  summary: 'Observed traffic', paragraphs: [], status: 'disrupted', charts: [],
  attribution: { source: 'Public source', url: 'https://example.com' },
};

beforeEach(() => { document.body.replaceChildren(); transport.fetch.mockReset(); });

describe('public Hormuz tracker', () => {
  it('renders the public tracker without protected dependency cards', async () => {
    transport.fetch.mockResolvedValue(data);
    const panel = new HormuzPanel();
    document.body.append(panel.getElement());
    expect(await panel.fetchData()).toBe(true);
    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('DISRUPTED'));
    expect(panel.getElement().textContent).not.toMatch(/Upgrade|Pro only|Sign in/);
    panel.destroy();
  });

  it('returns a degraded result when the public tape is unavailable', async () => {
    transport.fetch.mockResolvedValue(null);
    const panel = new HormuzPanel();
    expect(await panel.fetchData()).toBe(false);
    expect(panel.getElement().textContent).toContain('components.hormuzTracker.errors.unavailable');
    panel.destroy();
  });
});
