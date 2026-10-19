import {
  AudioPresets,
  Room,
  RoomEvent,
  setLogLevel,
  Track,
  VideoPresets,
  type LocalAudioTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from 'livekit-client'
import { showToast, updateSettings, useStore } from '../store'
import { noiseAudioContext, RnnoiseProcessor } from './noise'
import type { NoiseMode } from './settings'

// No modo de desenvolvimento, mostra no console cada passo da conexão de voz.
if (import.meta.env.DEV) setLogLevel('debug')

// Com o LiveKit atrás de um roteador sem portas abertas, a mídia só passa se o LiveKit mandar o
// primeiro pacote para o TURN do Cloudflare (isso libera a volta no roteador). Mas o TURN descarta
// esse pacote se chegar antes de o app pedir a "permissão" para o IP do servidor — e aí o LiveKit
// só tenta de novo uns 10–15 s depois. Segurando por um instante o envio dos nossos candidatos ao
// LiveKit, o app cria a permissão primeiro e a conexão fecha em 1–3 s.
const CANDIDATE_DELAY_MS = 1500
let delayCandidates = false

// O controle de banda do WebRTC começa em ~300 kbps e sobe devagar: sem isto, toda transmissão de
// tela passava quase um minuto borrada (320x180) antes de chegar na qualidade escolhida. O Chrome
// aceita a taxa inicial no SDP (x-google-start-bitrate, em kbps) dos codecs de vídeo.
const START_BITRATE_KBPS = 3000

function withStartBitrate(sdp: string): string {
  const lines = sdp.split('\r\n')
  const videoPayloads = new Set<string>()
  let inVideo = false
  for (const line of lines) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video')
    const codec = inVideo && line.match(/^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i)
    if (codec) videoPayloads.add(codec[1])
  }
  return lines
    .map((line) => {
      const fmtp = line.match(/^a=fmtp:(\d+) /)
      if (!fmtp || !videoPayloads.has(fmtp[1]) || line.includes('x-google-start-bitrate')) return line
      return `${line};x-google-start-bitrate=${START_BITRATE_KBPS}`
    })
    .join('\r\n')
}

{
  const NativePC = window.RTCPeerConnection
  window.RTCPeerConnection = class extends NativePC {
    set onicecandidate(handler: ((ev: RTCPeerConnectionIceEvent) => void) | null) {
      super.onicecandidate =
        handler && delayCandidates
          ? (ev) => setTimeout(() => handler.call(this, ev), CANDIDATE_DELAY_MS)
          : handler
    }
    get onicecandidate() {
      return super.onicecandidate
    }
    setRemoteDescription(description: RTCSessionDescriptionInit) {
      if (description?.sdp) {
        description = { type: description.type, sdp: withStartBitrate(description.sdp) }
      }
      return super.setRemoteDescription(description)
    }
  }
}
import { reportVoiceState } from './socket'
import { sounds } from './sounds'

export type ShareQuality = '720p30' | '720p60' | '1080p30' | '1080p60' | '1440p60'

// A taxa vale por pessoa assistindo e sai do upload de quem hospeda o servidor.
export const QUALITIES: Record<
  ShareQuality,
  { label: string; width: number; height: number; fps: number; bitrate: number }
> = {
  '720p30': { label: '720p 30fps · ~2,5 Mbps por amigo', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  '720p60': { label: '720p 60fps · ~4 Mbps por amigo', width: 1280, height: 720, fps: 60, bitrate: 4_000_000 },
  '1080p30': { label: '1080p 30fps · ~4,5 Mbps por amigo', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  '1080p60': { label: '1080p 60fps · ~7 Mbps por amigo', width: 1920, height: 1080, fps: 60, bitrate: 7_000_000 },
  '1440p60': { label: '1440p 60fps · ~10 Mbps por amigo', width: 2560, height: 1440, fps: 60, bitrate: 10_000_000 },
}

export interface ShareOptions {
  quality: ShareQuality
  audio: boolean
  /** motion = jogos/vídeos (fluidez); detail = texto/código (nitidez) */
  hint: 'motion' | 'detail'
}

let room: Room | null = null
/** tentativa de conexão em andamento (ainda não é a sala "oficial") */
let joining: Room | null = null
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
      // saída intencional, ou uma tentativa de conexão que falhou (joinVoice tenta de novo)
      if (room !== r || joining === r) return
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

/** Só os endereços STUN e TURN por UDP (tira turn:...?transport=tcp e turns:). */
function udpOnly(servers: RTCIceServer[]): RTCIceServer[] {
  return servers
    .map((s) => ({
      ...s,
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(
        (u) => u.startsWith('stun:') || (u.startsWith('turn:') && !/transport=tcp/i.test(u)),
      ),
    }))
    .filter((s) => s.urls.length > 0)
}

export async function joinVoice(channelId: string) {
  const { api, voiceChannelId, settings } = get()
  if (!api) return
  if (room && voiceChannelId === channelId) return
  await leaveVoice(true)

  set({ voiceChannelId: channelId, voiceStatus: 'connecting', speaking: [] })
  const createRoom = () =>
    new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        deviceId: settings.inputDeviceId || undefined,
        // no modo "ai" o RNNoise faz o trabalho; o filtro do WebRTC junto só piora a voz
        noiseSuppression: settings.noiseMode === 'basic',
        echoCancellation: settings.echoCancellation,
        autoGainControl: settings.autoGainControl,
      },
      videoCaptureDefaults: {
        deviceId: settings.videoDeviceId || undefined,
        resolution: VideoPresets.h720.resolution,
      },
      publishDefaults: { dtx: true, red: true },
    })

  let r: Room | null = null
  let lastError: unknown
  try {
    const { url, token, iceServers } = await api.livekitToken(channelId)
    // Com TURN configurado no servidor (Cloudflare Tunnel, sem portas abertas), a mídia só chega
    // ao LiveKit pelo retransmissor (ver CANDIDATE_DELAY_MS). Se a 1ª tentativa ainda assim não
    // fechar em 8 s, tentamos de novo em vez de esperar os 15 s padrão.
    const relay = !!iceServers?.length
    delayCandidates = relay
    const timeouts = relay ? [8_000, 15_000] : [15_000]

    for (const [index, timeout] of timeouts.entries()) {
      if (get().voiceChannelId !== channelId) return // saiu/trocou enquanto conectava
      const attempt = createRoom()
      room = attempt
      joining = attempt
      wire(attempt)
      // 1ª tentativa: qualquer caminho — quem está na mesma rede do servidor conecta direto
      // (sem gastar o upload da casa) e os de fora caem no TURN, só por UDP (por TCP o vídeo
      // engasga a cada pacote perdido). Se falhar, força o TURN e libera TCP/TLS, para redes
      // que bloqueiam UDP.
      const firstTry = index === 0
      const rtcConfig: RTCConfiguration | undefined = relay
        ? {
            iceTransportPolicy: firstTry ? 'all' : 'relay',
            iceServers: firstTry ? udpOnly(iceServers!) : iceServers!,
          }
        : undefined
      try {
        await attempt.connect(url, token, {
          peerConnectionTimeout: timeout,
          ...(rtcConfig ? { rtcConfig } : {}),
        })
        r = attempt
        lastError = undefined
        break
      } catch (err) {
        lastError = err
        await attempt.disconnect()
      } finally {
        if (joining === attempt) joining = null
      }
    }
  } catch (err) {
    lastError = err
  }

  if (!r) {
    if (get().voiceChannelId === channelId) {
      cleanup()
      showToast(`Não foi possível entrar na voz: ${errorText(lastError)}`)
    }
    return
  }
  if (room !== r) {
    // saiu/trocou enquanto conectava
    void r.disconnect()
    return
  }

  set({ voiceStatus: 'connected' })
  const { muted, deafened } = get()
  if (!muted && !deafened) {
    try {
      await r.localParticipant.setMicrophoneEnabled(true)
      await applyNoiseFilter()
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
    if (enabled) await applyNoiseFilter()
  } catch (err) {
    showToast(`Microfone indisponível: ${errorText(err)}`)
  }
}

function micTrack(): LocalAudioTrack | undefined {
  return room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as
    | LocalAudioTrack
    | undefined
}

/** Liga ou desliga o RNNoise no microfone conforme a configuração. */
async function applyNoiseFilter() {
  const track = micTrack()
  if (!track) return
  const want = get().settings.noiseMode === 'ai'
  const active = track.getProcessor()?.name === 'rnnoise'
  try {
    if (want && !active) {
      await track.setAudioContext(noiseAudioContext())
      await track.setProcessor(new RnnoiseProcessor())
    } else if (!want && active) {
      await track.stopProcessor()
    }
  } catch (err) {
    showToast(`Supressão de ruído indisponível: ${errorText(err)}`)
  }
}

/** Troca o modo de supressão de ruído na hora, mesmo no meio de uma chamada. */
export async function setNoiseMode(mode: NoiseMode) {
  updateSettings({ noiseMode: mode })
  const track = micTrack()
  if (!track) return
  try {
    // o filtro do WebRTC é uma configuração da captura: precisa reabrir o microfone
    await track.restartTrack({
      deviceId: get().settings.inputDeviceId || undefined,
      noiseSuppression: mode === 'basic',
      echoCancellation: get().settings.echoCancellation,
      autoGainControl: get().settings.autoGainControl,
    })
  } catch (err) {
    showToast(`Não foi possível reabrir o microfone: ${errorText(err)}`)
  }
  await applyNoiseFilter()
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
      // Para tela o LiveKit lê "screenShareEncoding" (e ignora "videoEncoding"); sem isso valia o
      // teto padrão do WebRTC de 2,5 Mbps e a transmissão ficava travada/borrada.
      screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps },
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
