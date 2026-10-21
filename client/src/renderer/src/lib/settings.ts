export interface GateSettings {
  enabled: boolean
  /** abaixo disso (em dB) o microfone fecha */
  thresholdDb: number
}

export interface Settings {
  inputDeviceId: string
  outputDeviceId: string
  videoDeviceId: string
  /** supressão de ruído por IA (RNNoise) */
  noiseSuppression: boolean
  /** iguala o volume da voz (ganho automático só enquanto a pessoa fala) */
  autoGain: boolean
  gate: GateSettings
  /** reduz e converte imagens para WebP antes de enviar no chat */
  optimizeImages: boolean
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
  autoGain: true,
  gate: { enabled: false, thresholdDb: -50 },
  optimizeImages: true,
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
    // versões antigas tinham 4 modos de supressão (noiseMode); qualquer um ligado vira "ligada"
    if (saved.noiseSuppression === undefined && typeof saved.noiseMode === 'string') {
      saved.noiseSuppression = saved.noiseMode !== 'off'
    }
    for (const old of ['noiseMode', 'noiseIntensity', 'micGainDb', 'echoCancellation', 'autoGainControl']) {
      delete saved[old]
    }
    return {
      ...defaultSettings,
      ...saved,
      shortcuts: { ...defaultSettings.shortcuts, ...saved.shortcuts },
      gate: { ...defaultSettings.gate, ...saved.gate },
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
