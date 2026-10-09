export const RESILIENCE_SCHEMA_V2_ENABLED = (process.env.RESILIENCE_SCHEMA_V2_ENABLED ?? 'true').toLowerCase() === 'true';

export function toResilienceDataVersion(value: unknown): string {
    const timestamp = typeof value === 'number' || typeof value === 'string'
        ? new Date(value)
        : null;
    if (!timestamp || !Number.isFinite(timestamp.getTime()))
        return '';
    return timestamp.toISOString().slice(0, 10);
}

export function isPillarCombineEnabled(): boolean {
    return process.env.RESILIENCE_PILLAR_COMBINE_ENABLED?.trim().toLowerCase() !== 'false';
}

export function isEnergyV2Enabled(): boolean {
    return (process.env.RESILIENCE_ENERGY_V2_ENABLED ?? 'false').toLowerCase() === 'true';
}

export function isFinancialSystemExposureEnabled(): boolean {
    return (process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED ?? 'false').toLowerCase() === 'true';
}

export const RESILIENCE_INTERVAL_KEY_PREFIX = 'resilience:intervals:v11:';

export const RESILIENCE_INTERVAL_METHODOLOGY = 'weight-perturbation-sensitivity-v3';

export const RESILIENCE_STATIC_META_KEY = 'seed-meta:resilience:static';

export const RESILIENCE_RANKING_META_KEY = 'seed-meta:resilience:ranking';

export const RESILIENCE_INTERVALS_META_KEY = 'seed-meta:resilience:intervals';

export type CacheFormulaTag = 'd6' | 'pc';

type EducationCacheState = 'education-on' | 'education-off';

export interface ResilienceConstructVersions {
    energy: 'legacy' | 'v2';
    education: 'active' | 'rollback';
    financialSystemExposure: 'active' | 'rollback';
}

function currentCacheFormula(): CacheFormulaTag {
    return isPillarCombineEnabled() && RESILIENCE_SCHEMA_V2_ENABLED ? 'pc' : 'd6';
}

function currentEducationCacheState(): EducationCacheState {
    return isEducationEnabled() ? 'education-on' : 'education-off';
}

export function getCurrentResilienceConstructVersions(): ResilienceConstructVersions {
    return {
        energy: isEnergyV2Enabled() ? 'v2' : 'legacy',
        education: currentEducationCacheState() === 'education-on' ? 'active' : 'rollback',
        financialSystemExposure: isFinancialSystemExposureEnabled() ? 'active' : 'rollback',
    };
}

function educationCacheStateMatches(value: unknown, current = currentEducationCacheState()): boolean {
    return value === current;
}

export interface ResilienceIntervalPayload {
    p05?: unknown;
    p95?: unknown;
    _formula?: unknown;
    _educationState?: unknown;
    draws?: unknown;
    computedAt?: unknown;
    methodology?: unknown;
}

export function getCurrentCacheFormula(): CacheFormulaTag {
    return currentCacheFormula();
}

export function isCurrentResilienceIntervalPayload(value: unknown): value is ResilienceIntervalPayload & {
    p05: number;
    p95: number;
    _formula: string;
    methodology: typeof RESILIENCE_INTERVAL_METHODOLOGY;
} {
    if (!value || typeof value !== 'object')
        return false;
    const payload = value as ResilienceIntervalPayload;
    return (typeof payload.p05 === 'number' &&
        Number.isFinite(payload.p05) &&
        typeof payload.p95 === 'number' &&
        Number.isFinite(payload.p95) &&
        payload.p05 >= 0 &&
        payload.p05 <= 100 &&
        payload.p95 >= 0 &&
        payload.p95 <= 100 &&
        payload.p05 <= payload.p95 &&
        payload._formula === currentCacheFormula() &&
        educationCacheStateMatches(payload._educationState) &&
        payload.methodology === RESILIENCE_INTERVAL_METHODOLOGY);
}

function isEducationEnabled(): boolean {
  return (process.env.RESILIENCE_EDUCATION_ENABLED ?? 'true').toLowerCase() === 'true';
}
