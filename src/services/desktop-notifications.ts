import { t } from '@/services/i18n';
import { showToast } from '@/utils/toast';

export type DesktopNotificationPermission = NotificationPermission | 'unsupported';

export function getDesktopNotificationPermission(): DesktopNotificationPermission {
  if (!window.isSecureContext || typeof window.Notification !== 'function') return 'unsupported';
  return window.Notification.permission;
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  const permission = getDesktopNotificationPermission();
  if (permission !== 'default') return permission;
  return window.Notification.requestPermission();
}

export function showDesktopNotification(
  title: string,
  body: string,
  tag: string,
  onActivate: () => void,
): Notification | null {
  if (getDesktopNotificationPermission() !== 'granted') return null;
  const reportError = (error: unknown): void => {
    console.error('[desktop-notifications] Delivery failed:', error);
    showToast(t('preferences.alertNotifications.deliveryFailed'));
  };
  try {
    const notification = new window.Notification(title, { body, tag });
    notification.addEventListener('click', () => {
      try {
        window.focus();
        onActivate();
      } finally {
        notification.close();
      }
    }, { once: true });
    notification.addEventListener('error', reportError, { once: true });
    return notification;
  } catch (error) {
    reportError(error);
    return null;
  }
}
