import { toIso2 } from '@/utils/country-codes';
export const FOLLOWED_COUNTRIES_STORAGE_KEY = 'wm-followed-countries-v1';
export const WM_FOLLOWED_COUNTRIES_CHANGED = 'wm-followed-countries-changed';
export type FollowMutationResult = { ok: true } | { ok: false; reason: 'INVALID_INPUT' | 'STORAGE_FULL' | 'DISABLED' };
export function isFollowFeatureEnabled(): boolean { return true; }
export function getFollowed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY) ?? '{"countries":[]}');
    return Array.isArray(value.countries) ? [...new Set<string>(value.countries.map(toIso2).filter(Boolean))] : [];
  } catch { return []; }
}
export function isFollowed(code: string): boolean {
  const normalized = toIso2(code);
  return normalized !== null && getFollowed().includes(normalized);
}
async function mutate(input: string, followed: boolean): Promise<FollowMutationResult> {
  const code = toIso2(input);
  if (!code || !/^[A-Z]{2}$/.test(code)) return { ok: false, reason: 'INVALID_INPUT' };
  const countries = new Set(getFollowed());
  if (followed) countries.add(code); else countries.delete(code);
  try { localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ countries: [...countries] })); }
  catch { return { ok: false, reason: 'STORAGE_FULL' }; }
  window.dispatchEvent(new Event(WM_FOLLOWED_COUNTRIES_CHANGED));
  return { ok: true };
}
export const addCountry = (input: string): Promise<FollowMutationResult> => mutate(input, true);
export const removeCountry = (input: string): Promise<FollowMutationResult> => mutate(input, false);
export function subscribe(handler: () => void): () => void {
  window.addEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  return () => window.removeEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === FOLLOWED_COUNTRIES_STORAGE_KEY || event.key === null) window.dispatchEvent(new Event(WM_FOLLOWED_COUNTRIES_CHANGED));
});
