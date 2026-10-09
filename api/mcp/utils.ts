export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

const MAX_JSON_RPC_ID_BYTES = 256;

export function safeJsonRpcId(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > MAX_JSON_RPC_ID_BYTES) return null;
  return utf8ByteLength(value) <= MAX_JSON_RPC_ID_BYTES ? value : null;
}
