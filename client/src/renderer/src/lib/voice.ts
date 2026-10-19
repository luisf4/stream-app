import {
  AudioPresets,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from 'livekit-client'
import { showToast, updateSettings, useStore } from '../store'
import { reportVoiceState } from './socket'
import { sounds } from './sounds'

export type ShareQuality = '720p30' | '1080p30' | '1080p60' | '1440p60'

export const QUALITIES: Record<
  ShareQuality,
  { label: string; width: number; height: number; fps: number; bitrate: number }
> = {
  '720p30': { label: '720p 30fps', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  '1080p30': { label: '1080p 30fps', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  '1080p60': { label: '1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 7_000_000 },
  '1440p60': { label: '1440p 60fps', width: 2560, height: 1440, fps: 60, bitrate: 10_000_000 },
}

export interface ShareOptions {
  quality: ShareQuality
  audio: boolean
  /** motion = jogos/vídeos (fluidez); detail = texto/código (nitidez) */
  hint: 'motion' | 'detail'
}

let room: Room | null = null
let mutedBeforeDeafen = false

interface AudioEntry {
  el: HTMLMediaElement
  name: string
  source: Track.Source
}
const audioEntries = new Map<string, AudioEntry>()

let audioContainer: HTMLDivElement | null = null
function container() {
  if (!audioContainer) {
    audioContainer = document.createElement('div')
    audioContainer.style.display = 'none'
    document.body.appendChild(audioContainer)
  }
  return audioContainer
}

const set = useStore.setState
const get = useStore.getState
const bump = () => set((s) => ({ roomVersion: s.roomVersion + 1 }))
const play = (sound: keyof typeof sounds) => {
  if (get().settings.sounds) sounds[sound]()
}
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const getRoom = () => room

// ---------- áudio recebido (volume, ensurdecer, saída) ----------

function applyAudio(entry: AudioEntry) {
  const { settings, deafened } = get()
  const volume = settings.volumes[entry.name]
  const value =
    entry.source === Track.Source.ScreenShareAudio ? (volume?.stream ?? 1) : (volume?.voice ?? 1)
  entry.el.volume = Math.min(Math.max(value, 0), 1)
  entry.el.muted = deafened
  const sink = settings.outputDeviceId
  const el = entry.el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
  if (el.setSinkId && sink) el.setSinkId(sink).catch(() => {})
}

export function refreshAudio() {
  audioEntries.forEach(applyAudio)
}

export function setUserVolume(name: string, kind: 'voice' | 'stream', value: number) {
  const volumes = get().settings.volumes
  const current = volumes[name] ?? { voice: 1, stream: 1 }
  updateSettings({ volumes: { ...volumes, [name]: { ...current, [kind]: value } } })
  refreshAudio()
}

// ---------- entrar / sair ----------

function wire(r: Room) {
  r.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach()
        container().appendChild(el)
        const entry = { el, name: participant.name || participant.identity, source: pub.source }
        audioEntries.set(pub.trackSid, entry)
        applyAudio(entry)
      }
      bump()
    },
  )
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
      if (track.kind === Track.Kind.Audio) {
        track.detach().forEach((el) => el.remove())
        audioEntries.delete(pub.trackSid)
      }
      bump()
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) =>
      set({ speaking: speakers.map((p) => p.identity) }),
    )
    .on(RoomEvent.ParticipantConnected, () => {
      play('join')
      bump()
    })
    .on(RoomEvent.ParticipantDisconnected, () => {
      play('leave')
      bump()
    })
    .on(RoomEvent.Reconnecting, () => set({ voiceStatus: 'reconnecting' }))
    .on(RoomEvent.Reconnected, () => {
      set({ voiceStatus: 'connected' })
      reportVoiceState()
    })
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        set({ sharing: false })
        reportVoiceState()
      }
      bump()
    })
    .on(RoomEvent.MediaDevicesError, (err) => showToast(`Erro no dispositivo: ${errorText(err)}`))
    .on(RoomEvent.Disconnected, () => {
      if (room !== r) return // saída intencional
      cleanup()
      showToast('Você foi desconectado da voz')
      reportVoiceState()
    })

  for (const event of [
    RoomEvent.TrackPublished,
    RoomEvent.TrackUnpublished,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.LocalTrackPublished,
    RoomEvent.ParticipantNameChanged,
  ]) {
    r.on(event, bump)
  }
}

function cleanup() {
  room = null
  audioEntries.forEach((e) => e.el.remove())
  audioEntries.clear()
  set({
    voiceChannelId: null,
    voiceStatus: 'idle',
    camera: false,
    sharing: false,
    speaking: [],
  })
  bump()
}

export async function joinVoice(channelId: string) {
  const { api, voiceChannelId, settings } = get()
  if (!api) return
  if (room && voiceChannelId === channelId) return
  await leaveVoice(true)

  set({ voiceChannelId: channelId, voiceStatus: 'connecting', speaking: [] })
  const r = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      deviceId: settings.inputDeviceId || undefined,
      noiseSuppression: settings.noiseSuppression,
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
    },
    videoCaptureDefaults: {
      deviceId: settings.videoDeviceId || undefined,
      resolution: VideoPresets.h720.resolution,
    },
    publishDefaults: { dtx: true, red: true },
  })
  room = r
  wire(r)

  try {
    const { url, token, iceServers } = await api.livekitToken(channelId)
    // Com TURN configurado no servidor (Cloudflare Tunnel, sem portas abertas),
    // a mídia só consegue chegar ao LiveKit pelo retransmissor.
    await r.connect(
      url,
      token,
      iceServers?.length ? { rtcConfig: { iceServers, iceTransportPolicy: 'relay' } } : undefined,
    )
  } catch (err) {
    if (room === r) {
      cleanup()
      showToast(`Não foi possível entrar na voz: ${errorText(err)}`)
    }
    r.disconnect()
    return
  }
  if (room !== r) return // saiu/trocou enquanto conectava

  set({ voiceStatus: 'connected' })
  const { muted, deafened } = get()
  if (!muted && !deafened) {
    try {
      await r.localParticipant.setMicrophoneEnabled(true)
    } catch (err) {
      set({ muted: true })
      showToast(`Microfone indisponível: ${errorText(err)}`)
    }
  }
  play('join')
  reportVoiceState()
  bump()
}

export async function leaveVoice(silent = false) {
  const r = room
  if (!r) return
  cleanup()
  reportVoiceState()
  if (!silent) play('leave')
  await r.disconnect()
}

// ---------- microfone / fone ----------

async function setMic(enabled: boolean) {
  try {
    await room?.localParticipant.setMicrophoneEnabled(enabled)
  } catch (err) {
    showToast(`Microfone indisponível: ${errorText(err)}`)
  }
}

export async function toggleMute() {
  const { muted, deafened } = get()
  if (deafened) {
    // desmutar enquanto ensurdecido também tira o ensurdecer (igual ao Discord)
    set({ deafened: false, muted: false })
    refreshAudio()
  } else {
    set({ muted: !muted })
  }
  const nowMuted = get().muted
  play(nowMuted ? 'mute' : 'unmute')
  reportVoiceState()
  await setMic(!nowMuted)
}

export async function toggleDeafen() {
  const { deafened, muted } = get()
  if (!deafened) {
    mutedBeforeDeafen = muted
    set({ deafened: true, muted: true })
  } else {
    set({ deafened: false, muted: mutedBeforeDeafen })
  }
  refreshAudio()
  play(get().deafened ? 'mute' : 'unmute')
  reportVoiceState()
  await setMic(!get().muted)
}

// ---------- câmera ----------

export async function toggleCamera() {
  if (!room) return showToast('Entre num canal de voz primeiro')
  const enable = !get().camera
  try {
    await room.localParticipant.setCameraEnabled(enable, {
      deviceId: get().settings.videoDeviceId || undefined,
      resolution: VideoPresets.h720.resolution,
    })
    set({ camera: enable })
  } catch (err) {
    set({ camera: false })
    showToast(`Câmera indisponível: ${errorText(err)}`)
  }
  reportVoiceState()
  bump()
}

// ---------- compartilhar tela ----------

export async function startScreenShare(sourceId: string, options: ShareOptions) {
  const r = room
  if (!r) return showToast('Entre num canal de voz primeiro')
  await stopScreenShare()
  const q = QUALITIES[options.quality]

  let stream: MediaStream
  try {
    await window.api.selectScreenSource(sourceId, options.audio)
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: q.width },
        height: { max: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      },
      audio: options.audio
        ? ({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // pede ao Chromium para não capturar o som do próprio app (a voz dos amigos)
            restrictOwnAudio: true,
          } as MediaTrackConstraints)
        : false,
    })
  } catch (err) {
    return showToast(`Não foi possível capturar a tela: ${errorText(err)}`)
  }

  if (room !== r) {
    stream.getTracks().forEach((t) => t.stop())
    return
  }

  const [video] = stream.getVideoTracks()
  const [audio] = stream.getAudioTracks()
  video.contentHint = options.hint
  video.addEventListener('ended', () => void stopScreenShare())

  try {
    await r.localParticipant.publishTrack(video, {
      source: Track.Source.ScreenShare,
      name: 'screen',
      simulcast: false,
      videoCodec: 'h264',
      videoEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps },
      degradationPreference: options.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
    })
    if (audio) {
      await r.localParticipant.publishTrack(audio, {
        source: Track.Source.ScreenShareAudio,
        name: 'screen-audio',
        dtx: false,
        red: false,
        forceStereo: true,
        audioPreset: AudioPresets.musicHighQualityStereo,
      })
    }
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    await stopScreenShare()
    return showToast(`Falha ao transmitir: ${errorText(err)}`)
  }

  set({ sharing: true })
  reportVoiceState()
  bump()
}

export async function stopScreenShare() {
  const lp = room?.localParticipant
  if (lp) {
    for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
      const pub = lp.getTrackPublication(source)
      if (pub?.track) await lp.unpublishTrack(pub.track, true).catch(() => {})
    }
  }
  if (get().sharing) {
    set({ sharing: false })
    reportVoiceState()
  }
  bump()
}

// ---------- troca de dispositivos ----------

export async function switchDevice(kind: 'audioinput' | 'audiooutput' | 'videoinput', deviceId: string) {
  if (kind === 'audioinput') updateSettings({ inputDeviceId: deviceId })
  if (kind === 'audiooutput') updateSettings({ outputDeviceId: deviceId })
  if (kind === 'videoinput') updateSettings({ videoDeviceId: deviceId })
  if (kind === 'audiooutput') refreshAudio()
  else await room?.switchActiveDevice(kind, deviceId).catch(() => {})
}
