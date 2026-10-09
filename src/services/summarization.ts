/** Browser-local news summaries and public server translation. */
import { SITE_VARIANT } from '@/config';
import { BETA_MODE } from '@/config/beta';
import type { SummarizeArticleResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { NewsServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils';
import { buildSummaryCacheKey } from '@/utils/summary-cache-key';

import { getCurrentLanguage } from './i18n';
import { mlWorker } from './ml-worker';
import { isFeatureAvailable, type RuntimeFeatureId } from './runtime-config';

export type SummarizationProvider = 'browser' | 'cache';

export interface SummarizationResult {
  summary: string;
  provider: SummarizationProvider;
  model: string;
  cached: boolean;
}

export type ProgressCallback = (step: number, total: number, message: string) => void;

export interface SummarizeOptions {
  skipBrowserFallback?: boolean;
  bodies?: string[];
}

const newsClient = new NewsServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const translationBreaker = createCircuitBreaker<SummarizeArticleResponse>({ name: 'News Translation', cacheTtlMs: 0 });
const summaryResultBreaker = createCircuitBreaker<SummarizationResult | null>({
  name: 'BrowserSummaryResult',
  cacheTtlMs: 2 * 60 * 60 * 1000,
  persistCache: true,
  maxCacheEntries: 128,
});
const emptyTranslation: SummarizeArticleResponse = {
  summary: '', provider: '', model: '', fallback: true, tokens: 0, error: '', errorType: '',
  status: 'SUMMARIZE_STATUS_UNSPECIFIED', statusDetail: '',
};

export async function generateSummary(
  headlines: string[],
  onProgress?: ProgressCallback,
  geoContext?: string,
  lang: string = 'en',
  options?: SummarizeOptions,
): Promise<SummarizationResult | null> {
  if (!headlines || headlines.length < 2 || options?.skipBrowserFallback || !mlWorker.isAvailable) return null;
  const bodies = options?.bodies;
  // Separate local-only entries from summaries cached by the retired server chain.
  const cacheKey = `browser:${await buildSummaryCacheKey(headlines, 'brief', geoContext, SITE_VARIANT, lang, undefined, bodies)}`;
  return summaryResultBreaker.execute(async () => {
    onProgress?.(1, 1, 'Running local AI model...');
    try {
      const topHeadlines = headlines.slice(0, 5);
      const hasBody = Array.isArray(bodies) && bodies.some(b => typeof b === 'string' && b.length > 0);
      const combinedText = topHeadlines.map((headline, i) => {
        const body = hasBody && typeof bodies?.[i] === 'string' ? bodies[i]!.slice(0, 200) : '';
        return body ? `${headline.slice(0, 80)} — ${body}` : headline.slice(0, 80);
      }).join('. ');
      const prompt = getCurrentLanguage() === 'fr'
        ? `Résumez le titre le plus important en 2 phrases concises (moins de 60 mots) : ${combinedText}`
        : `Summarize the most important headline in 2 concise sentences (under 60 words): ${combinedText}`;
      const modelId = BETA_MODE ? 'summarization-beta' : undefined;
      const [summary] = await mlWorker.summarize([prompt], modelId);
      if (!summary || summary.length < 20 || summary.toLowerCase().includes('summarize') || summary.toLowerCase().includes('résumez')) return null;
      const result: SummarizationResult = { summary, provider: 'browser', model: modelId || 't5-small', cached: false };

      return result;
    } catch (error) {

      console.warn('[Summarization] Browser T5 failed:', error);
      return null;
    }
  }, null, { cacheKey, shouldCache: result => result !== null });
}

const TRANSLATION_PROVIDERS: { featureId: RuntimeFeatureId; provider: string; label: string }[] = [
  { featureId: 'aiOllama', provider: 'ollama', label: 'Ollama' },
  { featureId: 'aiOpenRouter', provider: 'openrouter', label: 'OpenRouter' },
];

export async function translateText(
  text: string,
  targetLang: string,
  onProgress?: ProgressCallback,
): Promise<string | null> {
  if (!text) return null;
  for (const [i, provider] of TRANSLATION_PROVIDERS.entries()) {
    if (!isFeatureAvailable(provider.featureId)) continue;
    onProgress?.(i + 1, TRANSLATION_PROVIDERS.length, `Translating with ${provider.label}...`);
    try {
      const response = await translationBreaker.execute(() => newsClient.summarizeArticle({
        provider: provider.provider,
        headlines: [text],
        mode: 'translate',
        geoContext: '',
        variant: targetLang,
        lang: '',
        systemAppend: '',
        bodies: [],
      }), emptyTranslation);
      if (response.fallback || response.status === 'SUMMARIZE_STATUS_SKIPPED') continue;
      const translated = typeof response.summary === 'string' ? response.summary.trim() : '';
      if (translated) return translated;
    } catch (error) {
      console.warn(`${provider.label} translation failed`, error);
    }
  }
  return null;
}
