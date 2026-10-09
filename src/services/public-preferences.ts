import { ALL_PANELS } from '@/config/panels';
import type { PanelConfig } from '@/types';

/** Drop retired catalog entries at preference boundaries; retain local choices. */
export function sanitizePublicPanelSettings(settings: Record<string, PanelConfig>): Record<string, PanelConfig> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key in ALL_PANELS || key.startsWith('cw-') || key === 'runtime-config')
    .map(([key, config]) => {
      const { premium: _premium, proGated: _proGated, ...publicConfig } = config;
      return [key, publicConfig];
    }));
}

export function sanitizePublicLayers<T extends object>(layers: T): T {
  const source = layers as T & { resilienceScore?: unknown };
  const { resilienceScore: _retired, ...publicLayers } = source;
  return publicLayers as T;
}
