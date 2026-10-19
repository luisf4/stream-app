import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { startMicTest } from '../lib/noise'
import { logout } from '../lib/session'
import { isAiNoise, type NoiseIntensity, type NoiseMode } from '../lib/settings'
import { captureOptions, micSettings, setNoiseMode, switchDevice, updateMicSettings } from '../lib/voice'
import { updateSettings, useStore } from '../store'
import { LogOutIcon } from './Icons'
import { Modal } from './Modal'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const session = useStore((s) => s.session)!
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    const refresh = () => navigator.mediaDevices.enumerateDevices().then(setDevices)
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [])

  const byKind = (kind: MediaDeviceKind) => devices.filter((d) => d.kind === kind)

  return (
    <Modal title="Configurações" onClose={onClose} wide>
      <h3 className="settings-section">Voz e vídeo</h3>
      <div className="settings-grid">
        <DeviceSelect
          label="Microfone"
          devices={byKind('audioinput')}
          value={settings.inputDeviceId}
          onChange={(id) => switchDevice('audioinput', id)}
        />
        <DeviceSelect
          label="Saída de áudio"
          devices={byKind('audiooutput')}
          value={settings.outputDeviceId}
          onChange={(id) => switchDevice('audiooutput', id)}
        />
        <DeviceSelect
          label="Câmera"
          devices={byKind('videoinput')}
          value={settings.videoDeviceId}
          onChange={(id) => switchDevice('videoinput', id)}
        />
      </div>
      <div className="settings-grid">
        <label className="field">
          <span>Supressão de ruído</span>
          <select
            value={settings.noiseMode}
            onChange={(e) => setNoiseMode(e.target.value as NoiseMode)}
          >
            <option value="ai">IA (RNNoise) — tira teclado, ventilador, barulho de rua</option>
            <option value="ai2">IA (GTCRN) — modelo mais novo, voz um pouco mais abafada</option>
            <option value="basic">Padrão — filtro leve do navegador</option>
            <option value="off">Desligada</option>
          </select>
        </label>
        <label className="field">
          <span>Intensidade da IA</span>
          <select
            value={settings.noiseIntensity}
            disabled={!isAiNoise(settings.noiseMode)}
            onChange={(e) => updateMicSettings({ noiseIntensity: e.target.value as NoiseIntensity })}
          >
            <option value="low">Leve — preserva mais a voz</option>
            <option value="medium">Média</option>
            <option value="high">Forte — tira mais ruído, pode cortar sílabas</option>
          </select>
        </label>
      </div>
      <div className="settings-grid">
        <label className="field">
          <span>
            Volume do microfone: {settings.micGainDb > 0 ? '+' : ''}
            {settings.micGainDb} dB
          </span>
          <input
            type="range"
            min={-12}
            max={24}
            step={1}
            value={settings.micGainDb}
            onChange={(e) => updateMicSettings({ micGainDb: Number(e.target.value) })}
            onDoubleClick={() => updateMicSettings({ micGainDb: 0 })}
            title="Duplo clique volta para 0 dB"
          />
        </label>
        <label className="field">
          <span>Limiar do noise gate: {settings.gate.thresholdDb} dB</span>
          <input
            type="range"
            min={-80}
            max={-10}
            step={1}
            value={settings.gate.thresholdDb}
            disabled={!settings.gate.enabled}
            onChange={(e) =>
              updateMicSettings({ gate: { ...settings.gate, thresholdDb: Number(e.target.value) } })
            }
          />
        </label>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.gate.enabled}
          onChange={(e) => updateMicSettings({ gate: { ...settings.gate, enabled: e.target.checked } })}
        />
        Noise gate — só transmite quando o som passa do limiar (a marca na barra do teste)
      </label>
      <MicTest />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.echoCancellation}
          onChange={(e) => updateSettings({ echoCancellation: e.target.checked })}
        />
        Cancelamento de eco
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.autoGainControl && !isAiNoise(settings.noiseMode)}
          disabled={isAiNoise(settings.noiseMode)}
          onChange={(e) => updateSettings({ autoGainControl: e.target.checked })}
        />
        Ajuste automático de volume do microfone
        {isAiNoise(settings.noiseMode) && ' (desligado com a IA: use o volume do microfone acima)'}
      </label>
      <p className="hint">
        Supressão, volume do microfone e noise gate mudam na hora. Eco e volume automático valem a partir
        da próxima vez que você entrar num canal.
      </p>

      <h3 className="settings-section">Atalhos globais (funcionam com o app em segundo plano)</h3>
      <div className="settings-grid">
        <ShortcutInput
          label="Mutar / desmutar"
          value={settings.shortcuts.mute}
          onChange={(mute) => updateSettings({ shortcuts: { ...settings.shortcuts, mute } })}
        />
        <ShortcutInput
          label="Ensurdecer"
          value={settings.shortcuts.deafen}
          onChange={(deafen) => updateSettings({ shortcuts: { ...settings.shortcuts, deafen } })}
        />
      </div>

      <h3 className="settings-section">Chat</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.optimizeImages}
          onChange={(e) => updateSettings({ optimizeImages: e.target.checked })}
        />
        Otimizar imagens antes de enviar (bem menores, sem diferença visível; GIFs vão como estão)
      </label>

      <h3 className="settings-section">App</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.closeToTray}
          onChange={(e) => updateSettings({ closeToTray: e.target.checked })}
        />
        Ao fechar, continuar rodando na bandeja
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.notifications}
          onChange={(e) => updateSettings({ notifications: e.target.checked })}
        />
        Notificações de novas mensagens
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.sounds}
          onChange={(e) => updateSettings({ sounds: e.target.checked })}
        />
        Sons (entrar/sair, mutar, mensagens)
      </label>

      <h3 className="settings-section">Conta</h3>
      <p className="muted">
        Conectado em <b>{session.serverUrl}</b> como <b>{session.user.nickname}</b>
      </p>
      <div className="modal-actions">
        <button
          className="btn danger"
          onClick={() => {
            onClose()
            logout()
          }}
        >
          <LogOutIcon size={16} /> Sair do servidor
        </button>
      </div>
    </Modal>
  )
}

const METER_MIN_DB = -80
const meterPct = (db: number) => Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100))

/** Ouve o próprio microfone com o mesmo processamento da call, e mostra o nível e o limiar do gate. */
function MicTest() {
  const settings = useStore((s) => s.settings)
  const [running, setRunning] = useState(false)
  const [meter, setMeter] = useState({ db: -100, open: false })
  const [error, setError] = useState('')
  const testRef = useRef<Awaited<ReturnType<typeof startMicTest>> | null>(null)
  const capture = captureOptions(settings)

  const stop = () => {
    testRef.current?.stop()
    testRef.current = null
    setRunning(false)
  }

  const start = async () => {
    setError('')
    try {
      const current = useStore.getState().settings
      testRef.current = await startMicTest(
        {
          deviceId: current.inputDeviceId,
          mic: micSettings(current),
          ...captureOptions(current),
          outputDeviceId: current.outputDeviceId,
        },
        (db, open) => setMeter({ db, open }),
      )
      setRunning(true)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // troca de microfone ou de opção da captura durante o teste: reabre com a configuração nova
  useEffect(() => {
    if (!testRef.current) return
    stop()
    void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.inputDeviceId, capture.noiseSuppression, capture.autoGainControl, capture.echoCancellation])

  // o resto (IA, intensidade, ganho, gate) muda na hora
  useEffect(() => {
    testRef.current?.update(micSettings(settings))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.noiseMode, settings.noiseIntensity, settings.micGainDb, settings.gate])

  useEffect(() => stop, [])

  const gateOn = settings.gate.enabled
  return (
    <div className="field">
      <span>Teste de microfone (use fone)</span>
      <div className="mic-test">
        <button type="button" className="btn ghost-outline" onClick={running ? stop : start}>
          {running ? 'Parar' : 'Testar'}
        </button>
        <div className={`mic-level${gateOn && !meter.open ? ' closed' : ''}`}>
          <div style={{ width: `${meterPct(meter.db)}%` }} />
          {gateOn && (
            <i className="mic-threshold" style={{ left: `${meterPct(settings.gate.thresholdDb)}%` }} />
          )}
        </div>
      </div>
      {running && gateOn && (
        <small className="muted">{meter.open ? 'Gate aberto: transmitindo' : 'Gate fechado: em silêncio'}</small>
      )}
      {error && <small className="error">{error}</small>}
    </div>
  )
}

function DeviceSelect({
  label,
  devices,
  value,
  onChange,
}: {
  label: string
  devices: MediaDeviceInfo[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {!devices.some((d) => d.deviceId === value) && <option value={value}>Padrão</option>}
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  )
}

const KEY_NAMES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  '+': 'Plus',
}

function keyName(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3)
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5)
  if (/^Numpad\d$/.test(e.code)) return `num${e.code.slice(6)}`
  if (/^F\d{1,2}$/.test(e.key)) return e.key
  return KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
}

function ShortcutInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const [recording, setRecording] = useState(false)

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return
    e.preventDefault()
    if (e.key === 'Escape') return setRecording(false)
    if (e.key === 'Backspace' || e.key === 'Delete') {
      onChange('')
      return setRecording(false)
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
    const parts: string[] = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Super')
    parts.push(keyName(e))
    onChange(parts.join('+'))
    setRecording(false)
  }

  return (
    <label className="field">
      <span>{label}</span>
      <button
        type="button"
        className={`shortcut${recording ? ' recording' : ''}`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={onKeyDown}
      >
        {recording ? 'Pressione as teclas… (Backspace limpa)' : value || 'Nenhum'}
      </button>
    </label>
  )
}
