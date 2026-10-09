export const RETIRED_DATA_PATHS: ReadonlySet<string>;
export const RETIRED_ACCOUNT_PATHS: ReadonlySet<string>;
export const RETIRED_BOOTSTRAP_KEYS: ReadonlySet<string>;
export function retiredRouteResponse(request: Request, headers?: HeadersInit): Response | null;
export function denyRetiredRpc(): Promise<never>;
