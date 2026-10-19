import { useEffect, useState } from 'react'
import { ChatPanel } from '../components/ChatPanel'
import { ChatIcon, SpeakerIcon } from '../components/Icons'
import { ScreenPicker } from '../components/ScreenPicker'
import { SettingsModal } from '../components/SettingsModal'
import { Sidebar } from '../components/Sidebar'
import { VoiceStage } from '../components/VoiceStage'
import { logout } from '../lib/session'
import { connectSocket, disconnectSocket } from '../lib/socket'
import { leaveVoice, toggleDeafen, toggleMute } from '../lib/voice'
import { showToast, updateSettings, useStore } from '../store'

export function Main() {
  const session = useStore((s) => s.session)!
  const selectedChannelId = useStore((s) => s.selectedChannelId)
  const channel = useStore((s) => s.channels.find((c) => c.id === s.selectedChannelId))
  const inVoice = useStore(
    (s) => s.voiceStates.filter((v) => v.channelId === s.selectedChannelId).length,
  )
  const shortcuts = useStore((s) => s.settings.shortcuts)
  const closeToTray = useStore((s) => s.settings.closeToTray)
  const chatOpen = useStore((s) => s.settings.chatOpen)
  const toast = useStore((s) => s.toast)
  const [picker, setPicker] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    connectSocket(session, () => {
      logout()
      showToast('Sua sessão expirou ou a senha do servidor mudou. Entre de novo.')
    })
    const onUnload = () => void leaveVoice(true)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      void leaveVoice(true)
      disconnectSocket()
    }
  }, [session])

  useEffect(() => {
    window.api.setShortcuts(shortcuts).then((result) => {
      const failed = Object.entries(result)
        .filter(([, ok]) => !ok)
        .map(([action]) => (action === 'mute' ? shortcuts.mute : shortcuts.deafen))
      if (failed.length) showToast(`Atalho em uso por outro programa: ${failed.join(', ')}`)
    })
  }, [shortcuts])

  useEffect(
    () =>
      window.api.onShortcut((action) => {
        if (action === 'mute') void toggleMute()
        if (action === 'deafen') void toggleDeafen()
      }),
    [],
  )

  useEffect(
    () =>
      window.api.onFileDownloaded(({ ok, path }) =>
        showToast(ok ? `Salvo em ${path}` : 'Não foi possível baixar o arquivo'),
      ),
    [],
  )

  useEffect(() => window.api.setCloseToTray(closeToTray), [closeToTray])

  return (
    <div className="app">
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} onShareScreen={() => setPicker(true)} />

      <main className="content">
        {channel && selectedChannelId ? (
          <>
            <header className="content-header">
              <SpeakerIcon size={20} />
              <h2>{channel.name}</h2>
              <span className="muted">
                {inVoice === 0 ? 'ninguém na voz' : `${inVoice} na voz`}
              </span>
              <div className="spacer" />
              <button
                className={`icon-btn${chatOpen ? ' active' : ''}`}
                title={chatOpen ? 'Esconder chat' : 'Mostrar chat'}
                onClick={() => updateSettings({ chatOpen: !chatOpen })}
              >
                <ChatIcon />
              </button>
            </header>
            <div className="content-body">
              <VoiceStage channelId={selectedChannelId} onShareScreen={() => setPicker(true)} />
              {chatOpen && <ChatPanel key={selectedChannelId} channelId={selectedChannelId} />}
            </div>
          </>
        ) : (
          <div className="empty muted">Conectando ao servidor…</div>
        )}
      </main>

      {picker && <ScreenPicker onClose={() => setPicker(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
