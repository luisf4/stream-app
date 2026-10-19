export interface Settings {
  inputDeviceId: string
  outputDeviceId: string
  videoDeviceId: string
  noiseSuppression: boolean
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
  noiseSuppression: true,
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
