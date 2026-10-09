/** Local-only stable installation identity for non-account preferences. */
export function getUserId(): string {
  try {
    const existing = localStorage.getItem('wm-local-id');
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem('wm-local-id', id);
    return id;
  } catch { return 'local'; }
}
