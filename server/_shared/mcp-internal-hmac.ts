// Canonical request primitives retained for anonymous/operator sub-request admission.
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalQueryString(searchOrUrl: string | URL): string {
  let search: string;
  if (searchOrUrl instanceof URL) {
    search = searchOrUrl.search;
  } else if (typeof searchOrUrl === 'string') {
    if (searchOrUrl.startsWith('http://') || searchOrUrl.startsWith('https://')) {
      try { search = new URL(searchOrUrl).search; } catch { return ''; }
    } else {
      search = searchOrUrl;
    }
  } else {
    return '';
  }
  const entries = [...new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)];
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

export function canonicalGatewayQueryString(input: URL): string {
  const url = new URL(input);
  const segments = url.pathname.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? '';
  const rpcParams = url.searchParams.getAll('rpc');
  if (rpcParams.some(value => value === lastSegment)) {
    url.searchParams.delete('rpc');
    for (const value of rpcParams) if (value !== lastSegment) url.searchParams.append('rpc', value);
  }
  return canonicalQueryString(url);
}
