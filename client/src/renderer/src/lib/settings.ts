/** off = nada; basic = filtro do próprio WebRTC; ai = RNNoise (rede neural, bem mais forte) */
export type NoiseMode = 'off' | 'basic' | 'ai'

export interface Settings {
  inputDeviceId: string
  outputDeviceId: string
  videoDeviceId: string
  noiseMode: NoiseMode
  /** reduz e converte imagens para WebP antes de enviar no chat */
  optimizeImages: boolean
  echoCancellation: boolean
  autoGainControl: boolean
  shortcuts: { mute: string; deafen: string }
  closeToTray: boolean
  notifications: boolean
  sounds: boolean
  /** volume por apelido: voz e transmissão (0–1) */
  volumes: Record<string, { voice: number; stream: number }>
  chatOpen: boolean
}

const KEY = 'resenha.settings'

export const defaultSettings: Settings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  videoDeviceId: '',
  noiseMode: 'ai',
  optimizeImages: true,
  echoCancellation: true,
  autoGainControl: true,
  shortcuts: { mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' },
  closeToTray: true,
  notifications: true,
  sounds: true,
  volumes: {},
  chatOpen: true,
}

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return {
      ...defaultSettings,
      ...saved,
      shortcuts: { ...defaultSettings.shortcuts, ...saved.shortcuts },
    }
  } catch {
    return defaultSettings
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // sem armazenamento: as configurações valem só nesta sessão
  }
}
