/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Base URL of the ServeOS API. Public by nature: never put secrets in VITE_ variables. */
  readonly VITE_API_URL?: string;
  readonly VITE_KDS_URL?: string;
}
