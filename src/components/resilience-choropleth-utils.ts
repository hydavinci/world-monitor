import type { MapLayers } from '@/types';
import { sanitizePublicLayers } from '@/services/public-preferences';

export function normalizeExclusiveChoropleths(
  layers: MapLayers,
  _previousLayers?: object | null,
): MapLayers {
  return sanitizePublicLayers(layers);
}
