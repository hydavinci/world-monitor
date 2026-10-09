import { isSessionTokenShape, validateSessionToken } from './_session.js';
import { timingSafeIncludes } from './_crypto.js';

const DESKTOP_ORIGIN_PATTERNS = [
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

export function isDesktopOrigin(origin) {
  return Boolean(origin) && DESKTOP_ORIGIN_PATTERNS.some(pattern => pattern.test(origin));
}

export function getHeaderApiKey(req) {
  return req.headers.get('X-WorldMonitor-Key') || req.headers.get('X-Api-Key') || '';
}

async function isValidEnterpriseKey(key) {
  if (!key) return false;
  const configured = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  return timingSafeIncludes(key, configured);
}

async function validateCredential(key, forceKey) {
  if (isSessionTokenShape(key)) {
    if (forceKey) return { valid: false, required: true, error: 'Operator authentication required' };
    if (await validateSessionToken(key)) return { valid: true, required: false, kind: 'session' };
    return { valid: false, required: true, error: 'Invalid session token' };
  }
  // Configured operator keys are valid regardless of their prefix.
  if (key && await isValidEnterpriseKey(key)) {
    return { valid: true, required: true, kind: 'enterprise', credential: key };
  }
  return { valid: false, required: true, error: key ? 'Invalid API key' : 'API key required' };
}

function getCookie(req, name) {
  const raw = req.headers.get('Cookie') || req.headers.get('cookie') || '';
  const prefix = `${name}=`;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try { return decodeURIComponent(trimmed.slice(prefix.length)); }
    catch { return trimmed.slice(prefix.length); }
  }
  return '';
}

// Origin/Referer/Fetch-Metadata are not authentication. Only anonymous HMAC
// sessions and configured operator credentials can establish authority.
export async function validateApiKey(req, options = {}) {
  const forceKey = options.forceKey === true;
  const headerKey = getHeaderApiKey(req);
  const sessionCookie = getCookie(req, 'wm-session');
  // Retain legacy transport aliases only for explicitly configured operator keys.
  const operatorCookies = [
    getCookie(req, '__Host-wm-pro-key'), getCookie(req, '__Host-wm-widget-key'),
  ].filter(Boolean);
  const origin = req.headers.get('Origin') || '';

  if (isDesktopOrigin(origin)) {
    if (!headerKey) return { valid: false, required: true, error: 'API key required for desktop access' };
    if (!await isValidEnterpriseKey(headerKey)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true, kind: 'enterprise', credential: headerKey };
  }

  // Explicit machine credentials must never borrow ambient cookie authority.
  if (headerKey && !isSessionTokenShape(headerKey)) return validateCredential(headerKey, forceKey);
  for (const cookie of operatorCookies) {
    if (await isValidEnterpriseKey(cookie)) {
      return { valid: true, required: true, kind: 'enterprise', credential: cookie };
    }
  }
  if (headerKey) return validateCredential(headerKey, forceKey);
  if (sessionCookie) return validateCredential(sessionCookie, forceKey);
  return { valid: false, required: true, error: operatorCookies.length ? 'Invalid API key' : 'API key required' };
}
