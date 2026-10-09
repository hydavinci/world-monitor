import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreakingNewsBanner } from '@/components/BreakingNewsBanner';
import { destroyBreakingNewsAlerts, updateAlertSettings, type BreakingAlert } from '@/services/breaking-news-alerts';
import { renderPreferences } from '@/services/preferences-content';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { initTestI18n } from './helpers/i18n.mts';

const delivered: DesktopNotification[] = [];
class DesktopNotification extends EventTarget {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => {
    DesktopNotification.permission = 'granted';
    return 'granted' as NotificationPermission;
  });
  static fail = false;
  closed = false;
  constructor(public title: string, public options: NotificationOptions) {
    super();
    if (DesktopNotification.fail) throw new Error('Desktop delivery failed');
    delivered.push(this);
  }
  close(): void {
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }
}

function emit(overrides: Partial<BreakingAlert> = {}): void {
  document.dispatchEvent(new CustomEvent<BreakingAlert>('wm:breaking-news', { detail: {
    id: 'desktop-alert',
    headline: 'Verified urgent development',
    source: 'Reuters',
    threatLevel: 'critical',
    timestamp: new Date(),
    origin: 'rss_alert',
    corroboration: { state: 'corroborated', publishers: 2 },
    ...overrides,
  } }));
}

describe('desktop breaking-alert delivery and settings', () => {
  let banner: BreakingNewsBanner;
  let detach: (() => void) | undefined;
  beforeAll(initTestI18n);
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    destroyBreakingNewsAlerts();
    updateAlertSettings({ soundEnabled: false });
    delivered.length = 0;
    DesktopNotification.permission = 'granted';
    DesktopNotification.fail = false;
    DesktopNotification.requestPermission.mockReset().mockImplementation(async () => {
      DesktopNotification.permission = 'granted';
      return 'granted';
    });
    vi.stubGlobal('Notification', DesktopNotification);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('Audio', class {
      volume = 0;
      play = vi.fn().mockResolvedValue(undefined);
    });
    document.body.replaceChildren();
    banner = new BreakingNewsBanner();
  });
  afterEach(() => {
    detach?.();
    detach = undefined;
    banner.destroy();
    destroyBreakingNewsAlerts();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mountPreferences(): HTMLElement {
    const prefs = renderPreferences({ isDesktopApp: false });
    const container = document.createElement('div');
    setTrustedHtml(container, trustedHtml(prefs.html, 'Real preference template under test'));
    document.body.appendChild(container);
    detach = prefs.attach(container);
    return container;
  }

  it.each(['critical', 'high'] as const)('delivers a %s event with its headline, severity and source', threatLevel => {
    emit({ threatLevel });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.title).toBe('Verified urgent development');
    expect(delivered[0]!.options.body).toContain('Reuters');
    expect(delivered[0]!.options.body).toContain(t(`components.breakingNews.${threatLevel}`));
    expect(delivered[0]!.options.tag).toBe('wm-breaking-desktop-alert');
    expect(document.querySelector('.breaking-alert')).not.toBeNull();
  });

  it.each(['default', 'denied'] as const)('keeps the banner but never auto-prompts when permission is %s', permission => {
    DesktopNotification.permission = permission;
    emit();
    expect(delivered).toHaveLength(0);
    expect(DesktopNotification.requestPermission).not.toHaveBeenCalled();
    expect(document.querySelector('.breaking-alert')).not.toBeNull();
  });

  it.each([{ desktopNotificationsEnabled: false }, { enabled: false }])('honors the notification and master switches (%j)', settings => {
    updateAlertSettings(settings);
    emit();
    expect(delivered).toHaveLength(0);
  });

  it('does not notify again for the same active or dismissed alert', () => {
    emit();
    emit();
    document.querySelector<HTMLButtonElement>('.breaking-alert-dismiss')!.click();
    emit();
    expect(delivered).toHaveLength(1);
  });

  it('focuses the page and reveals the source panel on notification activation', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const reveal = vi.fn();
    window.addEventListener('wm:reveal-panel', reveal, { once: true });
    emit({ origin: 'oref_siren' });
    expect(delivered).toHaveLength(1);
    delivered[0]!.dispatchEvent(new Event('click'));
    expect(focus).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ detail: { panelId: 'oref-sirens' } }));
    expect(delivered[0]!.closed).toBe(true);
  });

  it('closes outstanding system notifications when the banner is destroyed', () => {
    emit();
    expect(delivered).toHaveLength(1);
    banner.destroy();
    expect(delivered[0]!.closed).toBe(true);
  });

  it('surfaces a delivery failure without preventing the page banner', () => {
    DesktopNotification.fail = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    emit();
    expect(log).toHaveBeenCalled();
    expect(document.querySelector('.toast-notification')?.textContent).toBe(t('preferences.alertNotifications.deliveryFailed'));
    expect(document.querySelector('.breaking-alert')).not.toBeNull();
  });

  it('requests permission only from the authorization button and then permits a test notification', async () => {
    DesktopNotification.permission = 'default';
    const container = mountPreferences();
    expect(DesktopNotification.requestPermission).not.toHaveBeenCalled();
    const authorize = container.querySelector<HTMLButtonElement>('#us-notification-permission');
    const test = container.querySelector<HTMLButtonElement>('#us-notification-test');
    expect(authorize).not.toBeNull();
    expect(test?.disabled).toBe(true);
    authorize!.click();
    await vi.waitFor(() => expect(test!.disabled).toBe(false));
    expect(DesktopNotification.requestPermission).toHaveBeenCalledOnce();
    expect(container.querySelector('#us-notification-status')?.textContent).toBe(t('preferences.alertNotifications.granted'));
    test!.click();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.title).toBe(t('preferences.alertNotifications.testTitle'));
  });

  it('shows denied-permission guidance without asking again', () => {
    DesktopNotification.permission = 'denied';
    const container = mountPreferences();
    const authorize = container.querySelector<HTMLButtonElement>('#us-notification-permission');
    expect(authorize).not.toBeNull();
    expect(authorize!.disabled).toBe(true);
    expect(container.querySelector('#us-notification-status')?.textContent).toBe(t('preferences.alertNotifications.denied'));
    expect(container.querySelector('#us-notification-test')?.hasAttribute('disabled')).toBe(true);
    expect(DesktopNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('persists disabling desktop notifications and disables the test button', () => {
    const container = mountPreferences();
    const toggle = container.querySelector<HTMLInputElement>('#us-desktop-notifications');
    expect(toggle).not.toBeNull();
    toggle!.checked = false;
    toggle!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(JSON.parse(localStorage.getItem('wm-breaking-alerts-v1')!).desktopNotificationsEnabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('#us-notification-test')!.disabled).toBe(true);
    emit();
    expect(delivered).toHaveLength(0);
  });

  it('reports an authorization error and allows retry without claiming permission was granted', async () => {
    DesktopNotification.permission = 'default';
    DesktopNotification.requestPermission.mockRejectedValueOnce(new Error('Permission request failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = mountPreferences();
    const authorize = container.querySelector<HTMLButtonElement>('#us-notification-permission');
    expect(authorize).not.toBeNull();
    authorize!.click();
    await vi.waitFor(() => expect(container.querySelector('#us-notification-status')?.textContent)
      .toBe(t('preferences.alertNotifications.permissionFailed')));
    expect(log).toHaveBeenCalled();
    expect(authorize!.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('#us-notification-test')!.disabled).toBe(true);
  });

  it.each(['missing-api', 'insecure'])('disables desktop controls when the browser is %s', reason => {
    if (reason === 'missing-api') vi.stubGlobal('Notification', undefined);
    else vi.stubGlobal('isSecureContext', false);
    const container = mountPreferences();
    expect(container.querySelector('#us-notification-status')?.textContent).toBe(t('preferences.alertNotifications.unsupported'));
    expect(container.querySelector<HTMLButtonElement>('#us-notification-permission')?.disabled).toBe(true);
    emit();
    expect(delivered).toHaveLength(0);
    expect(document.querySelector('.breaking-alert')).not.toBeNull();
  });
});
