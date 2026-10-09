import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserId } from '@/services/user-identity';

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local installation identity', () => {
  it('reuses the locally stored installation identity', () => {
    localStorage.setItem('wm-local-id', 'existing-installation');
    expect(getUserId()).toBe('existing-installation');
  });

  it('persists a new identity and reuses it on subsequent calls', () => {
    const id = getUserId();
    expect(id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    expect(localStorage.getItem('wm-local-id')).toBe(id);
    expect(getUserId()).toBe(id);
  });

  it('retains the local fallback when browser storage is null', () => {
    vi.stubGlobal('localStorage', null);
    expect(getUserId()).toBe('local');
  });

  it('retains the local fallback when reading storage is rejected', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementationOnce(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    expect(getUserId()).toBe('local');
  });

  it('retains the local fallback when persisting the identity is rejected', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    expect(getUserId()).toBe('local');
  });

  it('retains the local fallback when UUID creation is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    expect(getUserId()).toBe('local');
    expect(localStorage.getItem('wm-local-id')).toBeNull();
  });
});
