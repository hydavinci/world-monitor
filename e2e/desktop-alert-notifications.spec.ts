import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __desktopNotificationProbe: {
      requests: number;
      focused: number;
      notices: Array<{ title: string; body: string; tag: string; closed: boolean }>;
      activate: (index: number) => void;
      setPermission: (permission: NotificationPermission) => void;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-theme', 'light');
    localStorage.setItem('worldmonitor-language', 'en');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-breaking-alerts-v1', JSON.stringify({
      enabled: true, soundEnabled: false, desktopNotificationsEnabled: true, sensitivity: 'critical-and-high',
    }));
    const instances: DesktopNotification[] = [];
    class DesktopNotification extends EventTarget {
      static permission: NotificationPermission = 'default';
      static async requestPermission(): Promise<NotificationPermission> {
        window.__desktopNotificationProbe.requests++;
        DesktopNotification.permission = 'granted';
        return 'granted';
      }
      readonly record: { title: string; body: string; tag: string; closed: boolean };
      constructor(title: string, options: NotificationOptions) {
        super();
        this.record = { title, body: options.body ?? '', tag: options.tag ?? '', closed: false };
        instances.push(this);
        window.__desktopNotificationProbe.notices.push(this.record);
      }
      close(): void {
        this.record.closed = true;
        this.dispatchEvent(new Event('close'));
      }
    }
    window.__desktopNotificationProbe = {
      requests: 0,
      focused: 0,
      notices: [],
      activate: index => instances[index]!.dispatchEvent(new Event('click')),
      setPermission: permission => { DesktopNotification.permission = permission; },
    };
    // Replace only the operating-system boundary, not alert delivery or settings.
    Object.defineProperty(window, 'Notification', { configurable: true, value: DesktopNotification });
    const focus = window.focus.bind(window);
    window.focus = () => { window.__desktopNotificationProbe.focused++; focus(); };
  });
});

async function openNotificationSettings(page: Page): Promise<void> {
  await page.locator('#unifiedSettingsBtn').click();
  const group = page.locator('#unifiedSettingsModal details').filter({ hasText: 'Alert notifications' });
  await group.locator('summary').click();
  await expect(page.locator('#us-notification-permission')).toBeVisible();
}

test('real settings authorize desktop delivery and alert activation reveals its panel', async ({ page }, testInfo) => {
  await page.goto('/dashboard');
  await openNotificationSettings(page);
  await expect(page.locator('#us-notification-test')).toBeDisabled();
  expect(await page.evaluate(() => window.__desktopNotificationProbe.requests)).toBe(0);
  await page.locator('#us-notification-permission').click();
  await expect(page.locator('#us-notification-test')).toBeEnabled();
  await expect(page.locator('#us-notification-status')).toContainText('Browser permission granted');
  await page.locator('#us-notification-test').click();
  expect(await page.evaluate(() => window.__desktopNotificationProbe.notices[0]?.title))
    .toBe('World Monitor notification test');
  await page.evaluate(() => window.__desktopNotificationProbe.activate(0));
  await expect.poll(() => page.evaluate(() => window.__desktopNotificationProbe.focused)).toBe(1);
  await page.locator('label:has(#us-desktop-notifications)').click();
  await expect(page.locator('#us-desktop-notifications')).not.toBeChecked();
  await expect(page.locator('#us-notification-test')).toBeDisabled();
  await page.locator('label:has(#us-desktop-notifications)').click();
  await expect(page.locator('#us-desktop-notifications')).toBeChecked();
  await page.locator('#us-notification-status').screenshot({ path: testInfo.outputPath('desktop-permission-granted.png') });
  await page.locator('.unified-settings-close').click();
  await page.evaluate(() => {
    const alert = {
      id: 'desktop-e2e-siren',
      headline: 'Desktop notification integration check',
      source: 'OREF Pikud HaOref',
      origin: 'oref_siren',
      threatLevel: 'critical',
      timestamp: new Date(),
      corroboration: { state: 'unknown' },
    };
    document.dispatchEvent(new CustomEvent('wm:breaking-news', { detail: alert }));
    document.dispatchEvent(new CustomEvent('wm:breaking-news', { detail: alert }));
  });
  await expect(page.locator('.breaking-alert[data-alert-id="desktop-e2e-siren"]')).toBeVisible();
  const notices = await page.evaluate(() => window.__desktopNotificationProbe.notices);
  expect(notices).toHaveLength(2);
  expect(notices[1]!.title).toBe('Desktop notification integration check');
  expect(notices[1]!.body).toContain('OREF Pikud HaOref');
  expect(notices[1]!.tag).toBe('wm-breaking-desktop-e2e-siren');
  const revealed = await page.evaluate(() => new Promise<string>(resolve => {
    window.addEventListener('wm:reveal-panel', event => {
      resolve((event as CustomEvent<{ panelId: string }>).detail.panelId);
    }, { once: true });
    window.__desktopNotificationProbe.activate(1);
  }));
  expect(revealed).toBe('oref-sirens');
  expect(await page.evaluate(() => window.__desktopNotificationProbe.notices[1]!.closed)).toBe(true);
});

test('blocked browser permission is explained without repeated prompts', async ({ page }, testInfo) => {
  await page.goto('/dashboard');
  await page.evaluate(() => window.__desktopNotificationProbe.setPermission('denied'));
  await openNotificationSettings(page);
  await expect(page.locator('#us-notification-status')).toContainText("Notifications are blocked");
  await expect(page.locator('#us-notification-permission')).toBeDisabled();
  await expect(page.locator('#us-notification-test')).toBeDisabled();
  await page.locator('#us-notification-status').screenshot({ path: testInfo.outputPath('desktop-permission-denied.png') });
  expect(await page.evaluate(() => window.__desktopNotificationProbe.requests)).toBe(0);
  expect(await page.evaluate(() => window.__desktopNotificationProbe.notices)).toHaveLength(0);
});
