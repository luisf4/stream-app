import { Track, type Participant } from 'livekit-client'
import { useEffect, useRef, useState } from 'react'
import { getRoom, joinVoice, leaveVoice, stopScreenShare, toggleCamera, toggleMute } from '../lib/voice'
import { useStore } from '../store'
import { Avatar } from './Avatar'
import { ExpandIcon, MicIcon, MonitorIcon, PhoneOffIcon, VideoIcon } from './Icons'

interface TileData {
  key: string
  participant: Participant
  track?: Track
  kind: 'camera' | 'screen'
}

export function VoiceStage({
  channelId,
  onShareScreen,
}: {
  channelId: string
  onShareScreen: () => void
}) {
  const voiceChannelId = useStore((s) => s.voiceChannelId)
  const status = useStore((s) => s.voiceStatus)

  if (voiceChannelId !== channelId || status === 'connecting') {
    return <Lobby channelId={channelId} connecting={voiceChannelId === channelId} />
  }
  return <Stage onShareScreen={onShareScreen} />
}

function Lobby({ channelId, connecting }: { channelId: string; connecting: boolean }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))
  const members = useStore((s) => s.voiceStates).filter((v) => v.channelId === channelId)
  const inOtherChannel = useStore((s) => s.voiceChannelId !== null && s.voiceChannelId !== channelId)

  return (
    <section className="stage lobby">
      <h1>{channel?.name}</h1>
      {members.length > 0 ? (
        <div className="lobby-members">
          {members.map((m, i) => (
            <div key={`${m.userId}:${i}`} className="lobby-member">
              <Avatar name={m.nickname} size={64} />
              <span>{m.nickname}</span>
              {m.streaming && <span className="live">AO VIVO</span>}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">Ninguém na voz ainda.</p>
      )}
      <button className="btn primary big" disabled={connecting} onClick={() => joinVoice(channelId)}>
        {connecting ? 'Conectando…' : inOtherChannel ? 'Trocar para este canal' : 'Entrar no canal'}
      </button>
    </section>
  )
}

function Stage({ onShareScreen }: { onShareScreen: () => void }) {
  useStore((s) => s.roomVersion) // re-renderiza quando algo muda na sala
  const speaking = useStore((s) => s.speaking)
  const muted = useStore((s) => s.muted)
  const camera = useStore((s) => s.camera)
  const sharing = useStore((s) => s.sharing)
  const [focusKey, setFocusKey] = useState<string | null>(null)

  const room = getRoom()
  if (!room) return null
  const participants: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()]

  const tiles: TileData[] = []
  for (const p of participants) {
    const screen = p.getTrackPublication(Track.Source.ScreenShare)
    if (screen?.track) {
      tiles.push({ key: `${p.identity}:screen`, participant: p, track: screen.track, kind: 'screen' })
    }
  }
  for (const p of participants) {
    const cam = p.getTrackPublication(Track.Source.Camera)
    tiles.push({
      key: `${p.identity}:camera`,
      participant: p,
      track: cam?.track && !cam.isMuted ? cam.track : undefined,
      kind: 'camera',
    })
  }

  const focused = tiles.find((t) => t.key === focusKey)
  const others = focused ? tiles.filter((t) => t !== focused) : tiles
  const cols = Math.ceil(Math.sqrt(others.length))

  const toggleFocus = (key: string) => setFocusKey((k) => (k === key ? null : key))

  return (
    <section className="stage">
      {focused ? (
        <div className="stage-focus">
          <div className="focus-main">
            <Tile
              tile={focused}
              speaking={speaking.includes(focused.participant.identity)}
              onClick={() => toggleFocus(focused.key)}
            />
          </div>
          {others.length > 0 && (
            <div className="focus-strip">
              {others.map((t) => (
                <Tile
                  key={t.key}
                  tile={t}
                  speaking={speaking.includes(t.participant.identity)}
                  onClick={() => toggleFocus(t.key)}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="stage-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {tiles.map((t) => (
            <Tile
              key={t.key}
              tile={t}
              speaking={speaking.includes(t.participant.identity)}
              onClick={() => toggleFocus(t.key)}
            />
          ))}
        </div>
      )}

      <div className="stage-controls">
        <button className={`round-btn${muted ? ' off' : ''}`} title="Microfone" onClick={toggleMute}>
          <MicIcon slashed={muted} />
        </button>
        <button className={`round-btn${camera ? ' on' : ''}`} title="Câmera" onClick={toggleCamera}>
          <VideoIcon />
        </button>
        <button
          className={`round-btn${sharing ? ' on' : ''}`}
          title={sharing ? 'Parar transmissão' : 'Compartilhar tela'}
          onClick={sharing ? () => stopScreenShare() : onShareScreen}
        >
          <MonitorIcon />
        </button>
        <button className="round-btn danger" title="Sair da voz" onClick={() => leaveVoice()}>
          <PhoneOffIcon />
        </button>
      </div>
    </section>
  )
}

function Tile({
  tile,
  speaking,
  onClick,
}: {
  tile: TileData
  speaking: boolean
  onClick: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const { participant, track, kind } = tile
  const name = participant.name || participant.identity

  useEffect(() => {
    const el = videoRef.current
    if (!el || !track) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [track])

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else ref.current?.requestFullscreen()
  }

  return (
    <div
      ref={ref}
      className={`tile ${kind}${speaking && kind === 'camera' ? ' speaking' : ''}`}
      onClick={onClick}
      onDoubleClick={fullscreen}
    >
      {track ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={participant.isLocal && kind === 'camera' ? 'mirror' : undefined}
        />
      ) : (
        <Avatar name={name} size={72} speaking={speaking} />
      )}
      <div className="tile-label">
        {kind === 'screen' && <span className="live">AO VIVO</span>}
        <span>
          {name}
          {participant.isLocal ? ' (você)' : ''}
        </span>
        {kind === 'camera' && !participant.isMicrophoneEnabled && <MicIcon size={14} slashed />}
      </div>
      <button
        className="tile-fullscreen icon-btn"
        title="Tela cheia"
        onClick={(e) => {
          e.stopPropagation()
          fullscreen()
        }}
      >
        <ExpandIcon size={16} />
      </button>
    </div>
  )
}
