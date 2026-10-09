/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

interface ImportMetaEnv {
  readonly VITE_WS_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
