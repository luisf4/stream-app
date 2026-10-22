import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { startMicTest, type MicMeter } from '../lib/noise'
import { logout, replaceSession } from '../lib/session'
import { request } from '../lib/socket'
import { micSettings, switchDevice, updateMicSettings } from '../lib/voice'
import { showToast, updateSettings, useStore } from '../store'
import { LogOutIcon } from './Icons'
import { Modal } from './Modal'

type Tab = 'voice' | 'shortcuts' | 'app' | 'account' | 'admin'

const TABS: { id: Tab; label: string }[] = [
  { id: 'voice', label: 'Voz e vídeo' },
  { id: 'shortcuts', label: 'Atalhos' },
  { id: 'app', label: 'Chat e app' },
  { id: 'account', label: 'Conta' },
]

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('voice')
  const isAdmin = useStore((s) => !!s.session?.user.admin)
  const tabs = isAdmin ? [...TABS, { id: 'admin' as const, label: 'Admin' }] : TABS

  return (
    <Modal title="Configurações" onClose={onClose} className="settings-modal">
      <div className="settings">
        <nav className="settings-nav" role="tablist" aria-orientation="vertical">
          {tabs.map((t) => (
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
          {tab === 'account' && <AccountTab onClose={onClose} onAdmin={() => setTab('admin')} />}
          {tab === 'admin' && isAdmin && <AdminTab onLeft={() => setTab('account')} />}
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

function AccountTab({ onClose, onAdmin }: { onClose: () => void; onAdmin: () => void }) {
  const session = useStore((s) => s.session)!
  const [adminPrompt, setAdminPrompt] = useState(false)
  return (
    <>
      <h3>Conta</h3>
      <div className="settings-card">
        <dl className="account-info">
          <dt>Apelido</dt>
          <dd>{session.user.nickname}</dd>
          <dt>Servidor</dt>
          <dd>{session.serverUrl}</dd>
        </dl>
      </div>
      <h3>Atualizações</h3>
      <UpdateCard />
      <button
        className="btn danger"
        onClick={() => {
          onClose()
          logout()
        }}
      >
        <LogOutIcon size={16} /> Sair do servidor
      </button>
      {!session.user.admin && (
        <button className="admin-link" onClick={() => setAdminPrompt(true)}>
          admin
        </button>
      )}
      {adminPrompt && <AdminLogin onClose={() => setAdminPrompt(false)} onDone={onAdmin} />}
    </>
  )
}

function AdminLogin({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const api = useStore((s) => s.api)!
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  return (
    <Modal title="Entrar como admin" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setLoading(true)
          setError('')
          try {
            replaceSession(await api.setAdmin(password))
            onClose()
            onDone()
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setLoading(false)
          }
        }}
      >
        <label className="field">
          <span>Senha de admin</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!password || loading}>
            Entrar
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface Ban {
  deviceId: string
  nickname: string
  createdAt: number
}

function AdminTab({ onLeft }: { onLeft: () => void }) {
  const api = useStore((s) => s.api)!
  const connected = useStore((s) => s.socketConnected)
  const [bans, setBans] = useState<Ban[] | null>(null)

  useEffect(() => {
    if (!connected) return
    void request<{ bans: Ban[] }>('admin:bans', {}).then((res) => {
      if (res.ok) setBans(res.bans)
      else showToast(res.error ?? 'Erro')
    })
  }, [connected])

  const unban = async (ban: Ban) => {
    const res = await request<{ bans: Ban[] }>('admin:unban', { deviceId: ban.deviceId })
    if (res.ok) {
      setBans(res.bans)
      showToast(`${ban.nickname} pode entrar de novo`)
    } else showToast(res.error ?? 'Erro')
  }

  return (
    <>
      <h3>Admin</h3>
      <p className="muted">
        Clique com o botão direito em alguém (na lista Online, na voz ou no palco) para mutar na
        voz, expulsar da call ou banir. Você também pode apagar qualquer mensagem.
      </p>
      <h3>Banidos</h3>
      <div className="settings-card">
        {bans === null ? (
          <p className="muted">Carregando…</p>
        ) : bans.length === 0 ? (
          <p className="muted">Ninguém banido.</p>
        ) : (
          <ul className="ban-list">
            {bans.map((b) => (
              <li key={b.deviceId}>
                <span>
                  {b.nickname}
                  <small className="muted"> · {new Date(b.createdAt).toLocaleDateString('pt-BR')}</small>
                </span>
                <button className="btn ghost" onClick={() => unban(b)}>
                  Desbanir
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        className="btn ghost-outline"
        onClick={async () => {
          try {
            onLeft()
            replaceSession(await api.setAdmin(false))
          } catch (err) {
            showToast((err as Error).message)
          }
        }}
      >
        Deixar de ser admin
      </button>
    </>
  )
}

type UpdateState = Awaited<ReturnType<typeof window.api.getUpdateState>>

function updateText(u: UpdateState): string {
  switch (u.state) {
    case 'unsupported':
      return 'A atualização automática só funciona no app instalado no Windows.'
    case 'checking':
      return 'Procurando atualização…'
    case 'none':
      return 'Você está na versão mais nova.'
    case 'downloading':
      return `Baixando a versão ${u.version}… ${u.percent}%`
    case 'ready':
      return `A versão ${u.version} está pronta para instalar.`
    case 'error':
      return `Não deu para procurar agora: ${u.message}`
    default:
      return 'Procura sozinho a cada 10 minutos.'
  }
}

function UpdateCard() {
  const [update, setUpdate] = useState<UpdateState>({ state: 'idle' })
  useEffect(() => {
    void window.api.getUpdateState().then(setUpdate)
    return window.api.onUpdateState(setUpdate)
  }, [])

  const busy = update.state === 'checking' || update.state === 'downloading'
  return (
    <div className="settings-card update-status">
      <div>
        <div className="setting-title">Versão {__APP_VERSION__}</div>
        <div className="setting-description" role="status">
          {updateText(update)}
        </div>
        {update.state === 'downloading' && (
          <div className="update-progress">
            <div style={{ width: `${update.percent}%` }} />
          </div>
        )}
      </div>
      {update.state === 'ready' ? (
        <button className="btn primary" onClick={() => window.api.installUpdate()}>
          Reiniciar e instalar
        </button>
      ) : (
        update.state !== 'unsupported' && (
          <button
            className="btn ghost-outline"
            disabled={busy}
            onClick={() => void window.api.checkForUpdates().then(setUpdate)}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            Procurar atualização
          </button>
        )
      )}
    </div>
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
