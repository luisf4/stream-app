import type { DesktopApi } from '../../preload'

declare global {
  const __APP_VERSION__: string

  interface Window {
    api: DesktopApi
  }

  interface ImportMetaEnv {
    readonly VITE_SERVER_URL?: string
    readonly VITE_SERVER_PASSWORD?: string
  }
}

export {}
