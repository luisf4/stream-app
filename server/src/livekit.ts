import { RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import { config } from './config.js'

// Moderação na voz: cada canal de voz é uma sala do LiveKit e cada usuário entra com o id dele.

const rooms = new RoomServiceClient(
  config.livekit.apiUrl,
  config.livekit.apiKey,
  config.livekit.apiSecret,
)

const ALL_SOURCES = [
  TrackSource.MICROPHONE,
  TrackSource.CAMERA,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
]

/** O que a pessoa pode publicar; mutada por um admin, tudo menos o microfone. */
export const publishSources = (voiceMuted: boolean) =>
  voiceMuted ? ALL_SOURCES.filter((s) => s !== TrackSource.MICROPHONE) : ALL_SOURCES

export async function setVoiceMuted(room: string, identity: string, muted: boolean) {
  // a permissão é substituída inteira, então manda tudo
  await rooms.updateParticipant(room, identity, undefined, {
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
    canPublishSources: publishSources(muted),
  })
  if (!muted) return
  // garante que o microfone que já estava no ar caia na hora
  const participant = await rooms.getParticipant(room, identity)
  await Promise.all(
    participant.tracks
      .filter((t) => t.source === TrackSource.MICROPHONE && !t.muted)
      .map((t) => rooms.mutePublishedTrack(room, identity, t.sid, true)),
  )
}

export async function removeFromRoom(room: string, identity: string) {
  await rooms.removeParticipant(room, identity)
}
