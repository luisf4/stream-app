import { useEffect, useState, type KeyboardEvent } from 'react'
import { logout } from '../lib/session'
import { switchDevice } from '../lib/voice'
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
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.noiseSuppression}
          onChange={(e) => updateSettings({ noiseSuppression: e.target.checked })}
        />
        Supressão de ruído
      </label>
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
          checked={settings.autoGainControl}
          onChange={(e) => updateSettings({ autoGainControl: e.target.checked })}
        />
        Ajuste automático de volume do microfone
      </label>
      <p className="hint">Essas três opções valem a partir da próxima vez que você entrar num canal.</p>

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
