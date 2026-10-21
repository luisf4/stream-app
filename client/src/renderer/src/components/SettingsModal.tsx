import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { startMicTest, type MicMeter } from '../lib/noise'
import { logout } from '../lib/session'
import { micSettings, switchDevice, updateMicSettings } from '../lib/voice'
import { updateSettings, useStore } from '../store'
import { LogOutIcon } from './Icons'
import { Modal } from './Modal'

type Tab = 'voice' | 'shortcuts' | 'app' | 'account'

const TABS: { id: Tab; label: string }[] = [
  { id: 'voice', label: 'Voz e vídeo' },
  { id: 'shortcuts', label: 'Atalhos' },
  { id: 'app', label: 'Chat e app' },
  { id: 'account', label: 'Conta' },
]

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('voice')

  return (
    <Modal title="Configurações" onClose={onClose} className="settings-modal">
      <div className="settings">
        <nav className="settings-nav" role="tablist" aria-orientation="vertical">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-page" role="tabpanel">
          {tab === 'voice' && <VoiceTab />}
          {tab === 'shortcuts' && <ShortcutsTab />}
          {tab === 'app' && <AppTab />}
          {tab === 'account' && <AccountTab onClose={onClose} />}
        </div>
      </div>
    </Modal>
  )
}

// ---------- abas ----------

function VoiceTab() {
  const settings = useStore((s) => s.settings)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    const refresh = () => navigator.mediaDevices.enumerateDevices().then(setDevices)
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [])

  const byKind = (kind: MediaDeviceKind) => devices.filter((d) => d.kind === kind)
  const { gate } = settings

  return (
    <>
      <h3>Dispositivos</h3>
      <div className="settings-card">
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
        </div>
        <DeviceSelect
          label="Câmera"
          devices={byKind('videoinput')}
          value={settings.videoDeviceId}
          onChange={(id) => switchDevice('videoinput', id)}
        />
      </div>

      <h3>Microfone</h3>
      <div className="settings-card">
        <SettingRow
          title="Supressão de ruído"
          description="Remove teclado, ventilador e barulho de fundo."
          checked={settings.noiseSuppression}
          onChange={(noiseSuppression) => updateMicSettings({ noiseSuppression })}
        />
        <SettingRow
          title="Volume automático"
          description="Deixa sua voz no mesmo volume para todo mundo, falando baixo ou alto."
          checked={settings.autoGain}
          onChange={(autoGain) => updateMicSettings({ autoGain })}
        />
        <SettingRow
          title="Noise gate"
          description="Só transmite quando você fala. Ajuste a sensibilidade com o teste abaixo."
          checked={gate.enabled}
          onChange={(enabled) => updateMicSettings({ gate: { ...gate, enabled } })}
        >
          {gate.enabled && (
            <label className="field slider-field">
              <span>
                Sensibilidade <b>{gate.thresholdDb} dB</b>
              </span>
              <input
                type="range"
                min={-80}
                max={-10}
                step={1}
                value={gate.thresholdDb}
                onChange={(e) => updateMicSettings({ gate: { ...gate, thresholdDb: Number(e.target.value) } })}
              />
              <small className="muted">
                Mais para a esquerda capta voz mais baixa; mais para a direita corta mais barulho.
              </small>
            </label>
          )}
        </SettingRow>
        <MicTest />
      </div>
    </>
  )
}

function ShortcutsTab() {
  const shortcuts = useStore((s) => s.settings.shortcuts)
  return (
    <>
      <h3>Atalhos globais</h3>
      <p className="muted settings-intro">Funcionam mesmo com o app em segundo plano.</p>
      <div className="settings-card">
        <ShortcutInput
          label="Mutar / desmutar"
          value={shortcuts.mute}
          onChange={(mute) => updateSettings({ shortcuts: { ...shortcuts, mute } })}
        />
        <ShortcutInput
          label="Ensurdecer"
          value={shortcuts.deafen}
          onChange={(deafen) => updateSettings({ shortcuts: { ...shortcuts, deafen } })}
        />
      </div>
    </>
  )
}

function AppTab() {
  const settings = useStore((s) => s.settings)
  return (
    <>
      <h3>Chat</h3>
      <div className="settings-card">
        <SettingRow
          title="Otimizar imagens"
          description="Reduz as imagens antes de enviar, sem diferença visível. GIFs vão como estão."
          checked={settings.optimizeImages}
          onChange={(optimizeImages) => updateSettings({ optimizeImages })}
        />
        <SettingRow
          title="Notificações"
          description="Avisa quando chega mensagem nova com o app em segundo plano."
          checked={settings.notifications}
          onChange={(notifications) => updateSettings({ notifications })}
        />
        <SettingRow
          title="Sons"
          description="Entrar e sair da voz, mutar e mensagens."
          checked={settings.sounds}
          onChange={(sounds) => updateSettings({ sounds })}
        />
      </div>
      <h3>App</h3>
      <div className="settings-card">
        <SettingRow
          title="Continuar na bandeja ao fechar"
          description="Fechar a janela deixa o app rodando ao lado do relógio."
          checked={settings.closeToTray}
          onChange={(closeToTray) => updateSettings({ closeToTray })}
        />
      </div>
    </>
  )
}

function AccountTab({ onClose }: { onClose: () => void }) {
  const session = useStore((s) => s.session)!
  return (
    <>
      <h3>Conta</h3>
      <div className="settings-card">
        <dl className="account-info">
          <dt>Apelido</dt>
          <dd>{session.user.nickname}</dd>
          <dt>Servidor</dt>
          <dd>{session.serverUrl}</dd>
          <dt>Versão do app</dt>
          <dd>{__APP_VERSION__}</dd>
        </dl>
      </div>
      <button
        className="btn danger"
        onClick={() => {
          onClose()
          logout()
        }}
      >
        <LogOutIcon size={16} /> Sair do servidor
      </button>
    </>
  )
}

// ---------- peças ----------

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

/** Linha de configuração: título e descrição à esquerda, interruptor à direita. */
function SettingRow({
  title,
  description,
  checked,
  onChange,
  children,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
  children?: ReactNode
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-main">
        <div>
          <div className="setting-title">{title}</div>
          <div className="setting-description">{description}</div>
        </div>
        <Toggle checked={checked} onChange={onChange} label={title} />
      </div>
      {children}
    </div>
  )
}

const METER_MIN_DB = -80
const meterPct = (db: number) => Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100))

/** Ouve o próprio microfone com o mesmo processamento da call, e mostra o nível e o limiar do gate. */
function MicTest() {
  const settings = useStore((s) => s.settings)
  const [running, setRunning] = useState(false)
  const [meter, setMeter] = useState<MicMeter>({ db: -100, open: false, gainDb: 0 })
  const [error, setError] = useState('')
  const testRef = useRef<Awaited<ReturnType<typeof startMicTest>> | null>(null)

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
        { deviceId: current.inputDeviceId, mic: micSettings(current), outputDeviceId: current.outputDeviceId },
        setMeter,
      )
      setRunning(true)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // trocou de microfone durante o teste: reabre com o novo
  useEffect(() => {
    if (!testRef.current) return
    stop()
    void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.inputDeviceId])

  // supressão, volume automático e gate mudam na hora
  useEffect(() => {
    testRef.current?.update(micSettings(settings))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.noiseSuppression, settings.autoGain, settings.gate])

  useEffect(() => stop, [])

  const gateOn = settings.gate.enabled
  return (
    <div className="mic-test-box">
      <div className="mic-test">
        <button type="button" className={`btn ${running ? 'danger' : 'primary'}`} onClick={running ? stop : start}>
          {running ? 'Parar teste' : 'Testar microfone'}
        </button>
        <div className={`mic-level${gateOn && !meter.open ? ' closed' : ''}`}>
          <div style={{ width: `${meterPct(meter.db)}%` }} />
          {gateOn && (
            <i className="mic-threshold" style={{ left: `${meterPct(settings.gate.thresholdDb)}%` }} />
          )}
        </div>
      </div>
      <small className="muted">
        {!running
          ? 'Use fone: você vai ouvir sua própria voz como os outros ouvem.'
          : gateOn && !meter.open
            ? 'Gate fechado: em silêncio'
            : settings.autoGain
              ? `Transmitindo · volume automático ${meter.gainDb > 0 ? '+' : ''}${meter.gainDb.toFixed(0)} dB`
              : 'Transmitindo'}
      </small>
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
