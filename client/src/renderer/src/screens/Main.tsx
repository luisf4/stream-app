import { useEffect, useState } from 'react'
import { ChatPanel } from '../components/ChatPanel'
import { ChatIcon, HashIcon, SpeakerIcon } from '../components/Icons'
import { ConfirmModal } from '../components/Modal'
import { ScreenPicker } from '../components/ScreenPicker'
import { SettingsModal, type Tab as SettingsTab } from '../components/SettingsModal'
import { Sidebar } from '../components/Sidebar'
import { VoiceStage } from '../components/VoiceStage'
import { logout } from '../lib/session'
import { connectSocket, disconnectSocket, request } from '../lib/socket'
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
  const voiceChannelId = useStore((s) => s.voiceChannelId)
  const banTarget = useStore((s) => s.banTarget)
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)

  useEffect(() => {
    connectSocket(
      session,
      () => {
        logout()
        showToast('Sua sessão expirou ou a senha do servidor mudou. Entre de novo.')
      },
      () => {
        logout()
        useStore.setState({ notice: 'Você foi banido deste servidor.' })
      },
    )
    const onUnload = () => void leaveVoice(true)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      void leaveVoice(true)
      disconnectSocket()
    }
    // só o servidor/usuário importam: trocar o token (virar admin) reconecta sem sair da voz
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.serverUrl, session.user.id])

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

  // atualização automática: não instala no meio de uma call
  useEffect(() => window.api.setInVoice(!!voiceChannelId), [voiceChannelId])
  useEffect(() => {
    void window.api.pendingUpdate().then((version) => version && setUpdateVersion(version))
    return window.api.onUpdateReady(setUpdateVersion)
  }, [])

  return (
    <div className="app">
      <Sidebar onOpenSettings={(tab = 'voice') => setSettingsTab(tab)} onShareScreen={() => setPicker(true)} />

      <main className="content">
        {channel && selectedChannelId && channel.kind === 'text' ? (
          <>
            <header className="content-header">
              <HashIcon size={20} />
              <h2>{channel.name}</h2>
            </header>
            <div className="content-body">
              <ChatPanel key={selectedChannelId} channelId={selectedChannelId} wide />
            </div>
          </>
        ) : channel && selectedChannelId ? (
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
      {settingsTab && <SettingsModal initialTab={settingsTab} onClose={() => setSettingsTab(null)} />}
      {banTarget && (
        <ConfirmModal
          title={`Banir ${banTarget.nickname}`}
          text="A pessoa sai na hora e este PC não consegue mais entrar, nem com outro apelido. Dá para desbanir em Configurações → Admin."
          confirmText="Banir"
          onClose={() => useStore.setState({ banTarget: null })}
          onConfirm={async () => {
            useStore.setState({ banTarget: null })
            const res = await request('admin:ban', { userId: banTarget.id })
            showToast(res.ok ? `${banTarget.nickname} foi banido` : (res.error ?? 'Erro'))
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      {updateVersion && (
        <div className="update-card" role="status">
          <div className="update-card-text">
            <strong>Atualização pronta</strong>
            <span>
              A versão {updateVersion} já foi baixada.
              {voiceChannelId
                ? ' Ela instala sozinha quando você sair da voz e fechar a janela.'
                : ' Ela instala sozinha quando você fechar a janela.'}
            </span>
          </div>
          <div className="update-card-actions">
            <button className="btn ghost" onClick={() => setUpdateVersion(null)}>
              Depois
            </button>
            <button className="btn primary" onClick={() => window.api.installUpdate()}>
              {voiceChannelId ? 'Sair da call e instalar' : 'Reiniciar e instalar'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
