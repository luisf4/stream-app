import { useState } from 'react'
import { request } from '../lib/socket'
import type { Channel } from '../lib/types'
import { AdminActions } from './AdminActions'
import { UserVolume } from './UserVolume'
import {
  joinVoice,
  leaveVoice,
  stopScreenShare,
  toggleCamera,
  toggleDeafen,
  toggleMute,
} from '../lib/voice'
import { selectChannel, showToast, useStore } from '../store'
import { Avatar } from './Avatar'
import { ContextMenu } from './ContextMenu'
import {
  HashIcon,
  HeadphonesIcon,
  MicIcon,
  MonitorIcon,
  PhoneOffIcon,
  PlusIcon,
  SettingsIcon,
  SpeakerIcon,
  VideoIcon,
} from './Icons'
import { ConfirmModal, PromptModal } from './Modal'

type Menu =
  | { kind: 'channel'; x: number; y: number; channel: Channel }
  | { kind: 'user'; x: number; y: number; userId: string; nickname: string; voice: boolean }

type Dialog =
  | { type: 'create'; kind: Channel['kind'] }
  | { type: 'rename'; channel: Channel }
  | { type: 'delete'; channel: Channel }

export function Sidebar({
  onOpenSettings,
  onShareScreen,
}: {
  onOpenSettings: () => void
  onShareScreen: () => void
}) {
  const session = useStore((s) => s.session)!
  const channels = useStore((s) => s.channels)
  const selectedChannelId = useStore((s) => s.selectedChannelId)
  const voiceStates = useStore((s) => s.voiceStates)
  const unread = useStore((s) => s.unread)
  const mentioned = useStore((s) => s.mentioned)
  const voiceChannelId = useStore((s) => s.voiceChannelId)
  const voiceStatus = useStore((s) => s.voiceStatus)
  const speaking = useStore((s) => s.speaking)
  const online = useStore((s) => s.online)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)

  const run = async (event: string, payload: unknown) => {
    const res = await request(event, payload)
    if (!res.ok) showToast(res.error ?? 'Erro')
    setDialog(null)
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <span className="server-name">{session.server.name}</span>
        <span className="app-version">v{__APP_VERSION__}</span>
      </header>

      <nav className="channel-list">
        <div className="section-title">
          <span>Canais de texto</span>
          <button
            className="icon-btn"
            title="Criar canal de texto"
            onClick={() => setDialog({ type: 'create', kind: 'text' })}
          >
            <PlusIcon size={16} />
          </button>
        </div>
        {channels
          .filter((c) => c.kind === 'text')
          .map((channel) => {
            const count = unread[channel.id] ?? 0
            return (
              <button
                key={channel.id}
                className={`channel${selectedChannelId === channel.id ? ' selected' : ''}${count ? ' unread' : ''}`}
                onClick={() => selectChannel(channel.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ kind: 'channel', x: e.clientX, y: e.clientY, channel })
                }}
              >
                <HashIcon size={18} />
                <span className="channel-name">{channel.name}</span>
                {count > 0 && (
                  <span className="badge" title={mentioned[channel.id] ? 'Mencionaram você' : undefined}>
                    {mentioned[channel.id] ? '@' : ''}
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
            )
          })}

        <div className="section-title">
          <span>Canais de voz</span>
          <button
            className="icon-btn"
            title="Criar canal de voz"
            onClick={() => setDialog({ type: 'create', kind: 'voice' })}
          >
            <PlusIcon size={16} />
          </button>
        </div>
        {channels.filter((c) => c.kind !== 'text').map((channel) => {
          const members = voiceStates.filter((v) => v.channelId === channel.id)
          const count = unread[channel.id] ?? 0
          const joining = voiceChannelId === channel.id && voiceStatus === 'connecting'
          return (
            <div key={channel.id} className="channel-group">
              <button
                className={`channel${selectedChannelId === channel.id ? ' selected' : ''}${count ? ' unread' : ''}`}
                onClick={() => {
                  selectChannel(channel.id)
                  void joinVoice(channel.id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ kind: 'channel', x: e.clientX, y: e.clientY, channel })
                }}
                title="Clique para entrar na voz"
              >
                <SpeakerIcon size={18} />
                <span className="channel-name">{channel.name}</span>
                {joining && <span className="spinner" role="status" aria-label="Conectando" />}
                {count > 0 && (
                  <span className="badge" title={mentioned[channel.id] ? 'Mencionaram você' : undefined}>
                    {mentioned[channel.id] ? '@' : ''}
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
              {members.map((m, i) => (
                <div
                  key={`${m.userId}:${i}`}
                  className="voice-member"
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (m.userId !== session.user.id)
                      setMenu({
                        kind: 'user',
                        x: e.clientX,
                        y: e.clientY,
                        userId: m.userId,
                        nickname: m.nickname,
                        voice: true,
                      })
                  }}
                >
                  <Avatar
                    name={m.nickname}
                    size={24}
                    speaking={voiceChannelId === channel.id && speaking.includes(m.userId)}
                  />
                  <span className="member-name">{m.nickname}</span>
                  {m.streaming && <span className="live">AO VIVO</span>}
                  {m.camera && <VideoIcon size={14} />}
                  {m.deafened ? (
                    <HeadphonesIcon size={14} slashed />
                  ) : (
                    m.muted && <MicIcon size={14} slashed />
                  )}
                </div>
              ))}
            </div>
          )
        })}

        <div className="section-title">Online — {online.length}</div>
        {online.map((u) => (
          <div
            key={u.id}
            className="online-member"
            onContextMenu={(e) => {
              e.preventDefault()
              // o menu daqui só tem itens de admin
              if (session.user.admin && u.id !== session.user.id)
                setMenu({
                  kind: 'user',
                  x: e.clientX,
                  y: e.clientY,
                  userId: u.id,
                  nickname: u.nickname,
                  voice: false,
                })
            }}
          >
            <Avatar name={u.nickname} size={24} />
            <span className="member-name">{u.nickname}</span>
          </div>
        ))}
      </nav>

      <VoicePanel onShareScreen={onShareScreen} />
      <UserPanel onOpenSettings={onOpenSettings} />

      {menu?.kind === 'channel' && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.channel.kind !== 'text' && (
            <button
              onClick={() => {
                joinVoice(menu.channel.id)
                setMenu(null)
              }}
            >
              Entrar na voz
            </button>
          )}
          <button
            onClick={() => {
              setDialog({ type: 'rename', channel: menu.channel })
              setMenu(null)
            }}
          >
            Renomear canal
          </button>
          <button
            className="danger"
            onClick={() => {
              setDialog({ type: 'delete', channel: menu.channel })
              setMenu(null)
            }}
          >
            Apagar canal
          </button>
        </ContextMenu>
      )}
      {menu?.kind === 'user' && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.voice && <UserVolume nickname={menu.nickname} />}
          <AdminActions userId={menu.userId} nickname={menu.nickname} onDone={() => setMenu(null)} />
        </ContextMenu>
      )}

      {dialog?.type === 'create' && (
        <PromptModal
          title={dialog.kind === 'text' ? 'Criar canal de texto' : 'Criar canal de voz'}
          label="Nome do canal"
          confirmText="Criar"
          onClose={() => setDialog(null)}
          onSubmit={(name) => run('channel:create', { name, kind: dialog.kind })}
        />
      )}
      {dialog?.type === 'rename' && (
        <PromptModal
          title="Renomear canal"
          label="Novo nome"
          initial={dialog.channel.name}
          onClose={() => setDialog(null)}
          onSubmit={(name) => run('channel:rename', { id: dialog.channel.id, name })}
        />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmModal
          title="Apagar canal"
          text={`Apagar "${dialog.channel.name}"? As mensagens dele também serão apagadas.`}
          confirmText="Apagar"
          onClose={() => setDialog(null)}
          onConfirm={() => run('channel:delete', { id: dialog.channel.id })}
        />
      )}
    </aside>
  )
}

function VoicePanel({ onShareScreen }: { onShareScreen: () => void }) {
  const voiceChannelId = useStore((s) => s.voiceChannelId)
  const status = useStore((s) => s.voiceStatus)
  const channel = useStore((s) => s.channels.find((c) => c.id === s.voiceChannelId))
  const camera = useStore((s) => s.camera)
  const sharing = useStore((s) => s.sharing)
  if (!voiceChannelId) return null

  const label =
    status === 'connected'
      ? 'Voz conectada'
      : status === 'reconnecting'
        ? 'Reconectando…'
        : 'Conectando…'

  return (
    <div className="voice-panel">
      <div className="voice-status">
        <span className={`status-text ${status}`}>
          {status !== 'connected' && <span className="spinner" aria-hidden="true" />}
          {label}
        </span>
        <button className="link" onClick={() => selectChannel(voiceChannelId)}>
          {channel?.name ?? ''}
        </button>
      </div>
      <div className="voice-actions">
        <button
          className={`icon-btn${camera ? ' active' : ''}`}
          title={camera ? 'Desligar câmera' : 'Ligar câmera'}
          onClick={toggleCamera}
        >
          <VideoIcon size={18} />
        </button>
        <button
          className={`icon-btn${sharing ? ' active' : ''}`}
          title={sharing ? 'Parar transmissão' : 'Compartilhar tela'}
          onClick={sharing ? () => stopScreenShare() : onShareScreen}
        >
          <MonitorIcon size={18} />
        </button>
        <button className="icon-btn danger" title="Sair da voz" onClick={() => leaveVoice()}>
          <PhoneOffIcon size={18} />
        </button>
      </div>
    </div>
  )
}

function UserPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const user = useStore((s) => s.session!.user)
  const connected = useStore((s) => s.socketConnected)
  const muted = useStore((s) => s.muted)
  const deafened = useStore((s) => s.deafened)

  return (
    <div className="user-panel">
      <Avatar name={user.nickname} size={32} />
      <div className="user-info">
        <span className="user-name">{user.nickname}</span>
        <span className={`user-status${connected ? '' : ' offline'}`}>
          {connected ? 'Online' : 'Sem conexão…'}
        </span>
      </div>
      <button
        className="icon-btn"
        title={muted ? 'Desmutar' : 'Mutar'}
        onClick={toggleMute}
      >
        <MicIcon size={18} slashed={muted} />
      </button>
      <button
        className="icon-btn"
        title={deafened ? 'Ativar áudio' : 'Ensurdecer'}
        onClick={toggleDeafen}
      >
        <HeadphonesIcon size={18} slashed={deafened} />
      </button>
      <button className="icon-btn" title="Configurações" onClick={onOpenSettings}>
        <SettingsIcon size={18} />
      </button>
    </div>
  )
}
