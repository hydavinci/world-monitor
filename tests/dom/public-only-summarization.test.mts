import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  summarizeArticle: vi.fn(),
  getSummarizeArticleCache: vi.fn(),
  summarize: vi.fn(),
  loadModel: vi.fn(),
}));

vi.mock('@/config', () => ({ SITE_VARIANT: 'full' }));
vi.mock('@/config/beta', () => ({ BETA_MODE: false }));
vi.mock('@/services/generated-rpc-clients', () => ({
  NewsServiceClient: class {
    summarizeArticle = mocks.summarizeArticle;
    getSummarizeArticleCache = mocks.getSummarizeArticleCache;
  },
}));
vi.mock('@/services/rpc-client', () => ({
  getRpcBaseUrl: () => '',
  getRpcErrorStatusCode: () => undefined,
  rpcFetch: vi.fn(),
}));
vi.mock('@/services/ml-worker', () => ({
  mlWorker: { isAvailable: true, summarize: mocks.summarize, loadModel: mocks.loadModel },
}));
vi.mock('@/services/i18n', () => ({ getCurrentLanguage: () => 'en' }));
vi.mock('@/services/runtime-config', () => ({ isFeatureAvailable: () => true }));
vi.mock('@/utils', () => ({
  createCircuitBreaker: () => ({ execute: async (fn: () => Promise<unknown>) => fn() }),
}));
vi.mock('@/utils/summary-cache-key', () => ({ buildSummaryCacheKey: async () => 'test-summary' }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.summarize.mockResolvedValue(['A useful browser-local summary of the public news headlines.']);
  mocks.getSummarizeArticleCache.mockResolvedValue({ summary: 'Previously protected cached summary' });
  mocks.summarizeArticle.mockResolvedValue({
    summary: 'Translated headline', status: 'SUMMARIZE_STATUS_SUCCESS', fallback: false,
  });
});

describe('public-only news summaries and translation', () => {
  it('ignores legacy cloud-summary preferences and keeps browser inference opt-in', async () => {
    const { getAiFlowSettings, isAnyAiProviderEnabled } = await import('@/services/ai-flow-settings');
    localStorage.setItem('wm-ai-flow-cloud-llm', 'true');
    expect(getAiFlowSettings()).not.toHaveProperty('cloudLlm');
    expect(isAnyAiProviderEnabled()).toBe(false);
    localStorage.setItem('wm-ai-flow-browser-model', 'true');
    expect(isAnyAiProviderEnabled()).toBe(true);
  });

  it('summarizes in the browser without paid RPC or remote-cache access', async () => {
    const { generateSummary } = await import('@/services/summarization');
    const result = await generateSummary(['First public headline', 'Second public headline'], undefined, undefined, 'en', {
      bodies: ['Public article context', 'More public context'],
    });
    expect(result?.provider).toBe('browser');
    expect(result?.summary).toContain('browser-local');
    expect(mocks.summarize.mock.calls[0]?.[0][0]).toContain('Public article context');
    expect(mocks.summarizeArticle).not.toHaveBeenCalled();
    expect(mocks.getSummarizeArticleCache).not.toHaveBeenCalled();
  });

  it('does not fall back to server summaries when browser inference is disabled', async () => {
    const { generateSummary } = await import('@/services/summarization');
    expect(await generateSummary(['One', 'Two'], undefined, undefined, 'en', { skipBrowserFallback: true })).toBeNull();
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect(mocks.summarizeArticle).not.toHaveBeenCalled();
    expect(mocks.getSummarizeArticleCache).not.toHaveBeenCalled();
  });

  it('retains the public translate mode and full target-language tag', async () => {
    const { translateText } = await import('@/services/summarization');
    expect(await translateText('Public headline', 'zh-TW')).toBe('Translated headline');
    expect(mocks.summarizeArticle).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'translate', variant: 'zh-TW', headlines: ['Public headline'],
    }));
    expect(mocks.getSummarizeArticleCache).not.toHaveBeenCalled();
  });
});
