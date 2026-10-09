import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicRpc, RETIRED_RPC_PATHS } from '@/services/public-rpc-policy';

vi.mock('@/services/runtime', () => ({ getConfiguredWebApiBaseUrl: () => '' }));

afterEach(() => vi.unstubAllGlobals());

describe('permanent retired RPC policy', () => {
  it('rejects every frozen path before transport, regardless of supplied credentials', async () => {
    const { rpcFetch } = await import('@/services/rpc-client');
    const fetch = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    vi.stubGlobal('fetch', fetch);
    const credentialCases: HeadersInit[] = [{}, { Authorization: 'Bearer supplied-token', 'X-API-Key': 'supplied-key' }];
    for (const path of RETIRED_RPC_PATHS) {
      for (const headers of credentialCases) {
        expect(() => rpcFetch(`https://public.example${path}/?test=1`, { headers })).toThrow('Retired RPC');
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not allow URL-encoded retired paths to bypass the frozen policy', () => {
    for (const path of [
      '/api/intelligence/v1/%63lassify-event',
      '/api%2Fintelligence%2Fv1%2Fclassify-event',
    ]) expect(() => assertPublicRpc(path)).toThrow('Retired RPC');
  });

  it('preserves cancellation and explicit operator headers on public transport', async () => {
    const { rpcFetch } = await import('@/services/rpc-client');
    const response = Response.json({ chokepoints: [] });
    const fetch = vi.fn(() => Promise.resolve(response));
    vi.stubGlobal('fetch', fetch);
    const init = { signal: new AbortController().signal, headers: { 'X-Operator-Key': 'local-operator' } };
    expect(await rpcFetch('/api/supply-chain/v1/get-chokepoint-status', init)).toBe(response);
    expect(fetch).toHaveBeenCalledWith('/api/supply-chain/v1/get-chokepoint-status', init);
    expect(init.headers).toEqual({ 'X-Operator-Key': 'local-operator' });
  });
});
