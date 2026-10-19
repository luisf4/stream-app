/**
 * off = nada; basic = filtro do próprio WebRTC; ai = RNNoise (rede neural, bem mais forte);
 * ai2 = GTCRN (rede neural mais nova, corta menos a voz, mas trabalha em 16 kHz)
 */
export type NoiseMode = 'off' | 'basic' | 'ai' | 'ai2'

/** quanto a IA pode abaixar o ruído: leve corta menos a voz, forte tira mais ruído */
export type NoiseIntensity = 'low' | 'medium' | 'high'

export interface GateSettings {
  enabled: boolean
  /** abaixo disso (em dB) o microfone fecha */
  thresholdDb: number
}

export interface Settings {
  inputDeviceId: string
  outputDeviceId: string
  videoDeviceId: string
  noiseMode: NoiseMode
  noiseIntensity: NoiseIntensity
  /** ganho manual do microfone, em dB */
  micGainDb: number
  gate: GateSettings
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
  noiseIntensity: 'medium',
  micGainDb: 0,
  gate: { enabled: false, thresholdDb: -50 },
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
      gate: { ...defaultSettings.gate, ...saved.gate },
    }
  } catch {
    return defaultSettings
  }
}

export const isAiNoise = (mode: NoiseMode) => mode === 'ai' || mode === 'ai2'

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // sem armazenamento: as configurações valem só nesta sessão
  }
}
