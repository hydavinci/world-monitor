import { scheduleAfterFirstPaint } from '@/utils/after-paint';
import {
  STRIPPABLE_AT_BOOT_RE,
  scrubUrl,
} from '../../shared/sensitive-url-params';

let dashboardFontsScheduled = false;

export interface DashboardFontContext {
  variant?: string | null;
  lang?: string | null;
  dir?: string | null;
}

export type DashboardFontFamily = 'nunito' | 'tajawal';

// Which web-font families the dashboard actually needs for a given variant/locale.
// The default (full variant, LTR/non-Arabic) needs none — its body font is the
// system/mono stack — so those users download zero web fonts.
export function dashboardFontFamilies(context: DashboardFontContext = {}): DashboardFontFamily[] {
  const variant = (context.variant || 'full').toLowerCase();
  const lang = (context.lang || 'en').split('-')[0]?.toLowerCase() || 'en';
  const dir = (context.dir || '').toLowerCase();
  const families: DashboardFontFamily[] = [];

  if (variant === 'happy') families.push('nunito');             // happy theme body font
  if (dir === 'rtl' || lang === 'ar') families.push('tajawal'); // Arabic body font

  return families;
}

// Self-hosted @fontsource loaders — Vite bundles these to hashed /assets/*.woff2,
// served immutable (vercel.json) and therefore cached at the CDN/Cloudflare edge
// (unlike fonts.gstatic.com, a third-party origin). Each family pulls only the
// weights the UI actually uses.
const DASHBOARD_FONT_LOADERS: Record<DashboardFontFamily, () => Promise<unknown>> = {
  nunito: () => Promise.all([
    import('@fontsource/nunito/400.css'),
    import('@fontsource/nunito/600.css'),
    import('@fontsource/nunito/700.css'),
    import('@fontsource/nunito/400-italic.css'),
  ]),
  tajawal: () => Promise.all([
    import('@fontsource/tajawal/400.css'),
    import('@fontsource/tajawal/500.css'),
    import('@fontsource/tajawal/700.css'),
  ]),
};

function getBuildVariant(): string {
  try {
    return import.meta.env.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
}

let dashboardFontsLoaded = false;

function loadDeferredDashboardFonts(): void {
  if (typeof document === 'undefined' || dashboardFontsLoaded) return;

  const root = document.documentElement;
  const families = dashboardFontFamilies({
    variant: root.dataset.variant || getBuildVariant(),
    lang: root.lang || 'en',
    dir: root.dir || '',
  });
  if (families.length === 0) return;

  dashboardFontsLoaded = true;
  void Promise.all(families.map((family) => DASHBOARD_FONT_LOADERS[family]())).catch(() => {
    // Self-hosted fonts are best-effort; the system fallback stack covers failures.
  });
}

export function initDeferredDashboardFonts(): void {
  if (dashboardFontsScheduled) return;
  dashboardFontsScheduled = true;
  scheduleAfterFirstPaint(loadDeferredDashboardFonts, 3000);
}

/**
 * Strip params nobody reads from the live URL. Deferred readers remove their
 * own parameters after consuming them.
 */
export function stripSensitiveParamsFromUrl(): void {
  if (typeof window === 'undefined') return;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  if (!scrubUrl(url, STRIPPABLE_AT_BOOT_RE)) return;
  const query = url.searchParams.toString();
  try {
    window.history.replaceState({}, '', url.pathname + (query ? `?${query}` : '') + url.hash);
  } catch {
    console.warn('[URL] Unable to remove sensitive parameters from browser history.');
  }
}
