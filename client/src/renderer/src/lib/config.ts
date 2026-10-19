import { normalizeServerUrl } from './api'

// Vem de client/.env e é embutido no app durante o build.
// Se estiver vazio, o app pede endereço e senha na tela de login.
const serverUrl = import.meta.env.VITE_SERVER_URL?.trim()
const password = import.meta.env.VITE_SERVER_PASSWORD

export const presetServer =
  serverUrl && password ? { serverUrl: normalizeServerUrl(serverUrl), password } : null
