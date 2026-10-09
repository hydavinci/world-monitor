import { isStorageAvailable, safeStorageGetChecked, safeStorageSetChecked } from '@/utils/safe-storage';

/** Local-only stable installation identity for non-account preferences. */
export function getUserId(): string {
  try {
    const existing = safeStorageGetChecked('wm-local-id');
    if (!existing.ok) return 'local';
    if (existing.value) return existing.value;
    const id = crypto.randomUUID();
    return safeStorageSetChecked('wm-local-id', id) && isStorageAvailable() ? id : 'local';
  } catch { return 'local'; }
}
