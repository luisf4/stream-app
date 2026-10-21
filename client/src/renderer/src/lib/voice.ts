import {
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
import { MicProcessor, noiseAudioContext, type MicSettings } from './noise'
import { startScreenAudio, stopScreenAudio } from './screenAudio'
import { isAiNoise, type NoiseMode, type Settings } from './settings'

// No modo de desenvolvimento, mostra no console cada passo da conexão de voz.
if (import.meta.env.DEV) setLogLevel('debug')

// O controle de banda do WebRTC começa em ~300 kbps e sobe devagar: sem isto, toda transmissão de
// tela passava quase um minuto borrada (320x180) antes de chegar na qualidade escolhida. O Chrome
// aceita a taxa inicial no SDP (x-google-start-bitrate, em kbps) dos codecs de vídeo. Acompanha a
// qualidade da transmissão (ver startScreenShare): começa em ~60% da taxa alvo, o resto ele sobe rápido.
let startBitrateKbps = 3000

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
      return `${line};x-google-start-bitrate=${startBitrateKbps}`
    })
    .join('\r\n')
}

{
  const NativePC = window.RTCPeerConnection
  window.RTCPeerConnection = class extends NativePC {
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

export type ShareQuality = '1080p30' | '720p30'

// A taxa vale por pessoa assistindo e sai do upload de quem hospeda o servidor. Jogo com muito
// movimento precisa de mais bits que texto parado.
export const QUALITIES: Record<
  ShareQuality,
  { label: string; width: number; height: number; fps: number; bitrate: number; motionBitrate: number }
> = {
  '1080p30': { label: '1080p 30fps', width: 1920, height: 1080, fps: 30, bitrate: 10_000_000, motionBitrate: 20_000_000 },
  '720p30': { label: '720p 30fps', width: 1280, height: 720, fps: 30, bitrate: 5_000_000, motionBitrate: 10_000_000 },
}

export function shareBitrate(quality: ShareQuality, hint: ShareOptions['hint']) {
  const q = QUALITIES[quality]
  return hint === 'motion' ? q.motionBitrate : q.bitrate
}

const SCREEN_AUDIO_BPS = 96_000

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
  track: MediaStreamTrack
  name: string
  source: Track.Source
  /** amplificador (Web Audio), criado só quando o volume passa de 100% */
  boost?: { source: MediaStreamAudioSourceNode; gain: GainNode }
}
const audioEntries = new Map<string, AudioEntry>()

/** Volume por pessoa vai de 0 a 200%. */
export const MAX_USER_VOLUME = 2

// Até 100% o volume é do próprio <audio> (mantém o cancelamento de eco do navegador). Acima disso
// o som passa por um GainNode — o <audio> continua tocando mudo, senão o Chrome não entrega o áudio
// remoto ao Web Audio.
let playbackCtx: AudioContext | null = null
function playbackContext() {
  playbackCtx ??= new AudioContext()
  if (playbackCtx.state === 'suspended') void playbackCtx.resume()
  return playbackCtx
}

function removeBoost(entry: AudioEntry) {
  entry.boost?.source.disconnect()
  entry.boost?.gain.disconnect()
  entry.boost = undefined
}

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

type SinkTarget = { setSinkId?: (id: string) => Promise<void> }

function applyAudio(entry: AudioEntry) {
  const { settings, deafened } = get()
  const volume = settings.volumes[entry.name]
  const raw =
    entry.source === Track.Source.ScreenShareAudio ? (volume?.stream ?? 1) : (volume?.voice ?? 1)
  const value = Math.min(Math.max(raw, 0), MAX_USER_VOLUME)
  const sink = settings.outputDeviceId

  if (value <= 1 || deafened) {
    removeBoost(entry)
    entry.el.volume = value
    entry.el.muted = deafened
    const el = entry.el as HTMLMediaElement & SinkTarget
    if (el.setSinkId && sink) el.setSinkId(sink).catch(() => {})
    return
  }

  // acima de 100%: <audio> mudo + amplificador
  entry.el.muted = true
  const ctx = playbackContext()
  if (!entry.boost) {
    const source = ctx.createMediaStreamSource(new MediaStream([entry.track]))
    const gain = ctx.createGain()
    source.connect(gain).connect(ctx.destination)
    entry.boost = { source, gain }
  }
  entry.boost.gain.gain.value = value
  const sinkCtx = ctx as AudioContext & SinkTarget
  if (sinkCtx.setSinkId && sink) {
    sinkCtx.setSinkId(sink === 'default' ? '' : sink).catch(() => {})
  }
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

/** Volta voz e transmissão da pessoa para 100%. */
export function resetUserVolume(name: string) {
  const volumes = { ...get().settings.volumes }
  delete volumes[name]
  updateSettings({ volumes })
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
        const entry: AudioEntry = {
          el,
          track: track.mediaStreamTrack,
          name: participant.name || participant.identity,
          source: pub.source,
        }
        audioEntries.set(pub.trackSid, entry)
        applyAudio(entry)
      }
      bump()
    },
  )
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
      if (track.kind === Track.Kind.Audio) {
        track.detach().forEach((el) => el.remove())
        const entry = audioEntries.get(pub.trackSid)
        if (entry) removeBoost(entry)
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
      // saída intencional, ou a tentativa de conexão que falhou (joinVoice trata)
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
  audioEntries.forEach((e) => {
    removeBoost(e)
    e.el.remove()
  })
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
  const createRoom = () =>
    new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        deviceId: settings.inputDeviceId || undefined,
        ...captureOptions(settings),
      },
      videoCaptureDefaults: {
        deviceId: settings.videoDeviceId || undefined,
        resolution: VideoPresets.h720.resolution,
      },
      // sem DTX: com a supressão de ruído o fim das frases fica bem baixo, e o DTX cortava ali
      publishDefaults: { dtx: false, red: true },
    })

  let r: Room | null = null
  let lastError: unknown
  try {
    const { url, token } = await api.livekitToken(channelId)
    if (get().voiceChannelId !== channelId) return // saiu/trocou enquanto conectava
    const attempt = createRoom()
    room = attempt
    joining = attempt
    wire(attempt)
    try {
      // sem UDP, o próprio LiveKit cai para TCP (porta 7881)
      await attempt.connect(url, token, { peerConnectionTimeout: 15_000 })
      r = attempt
    } catch (err) {
      lastError = err
      await attempt.disconnect()
    } finally {
      if (joining === attempt) joining = null
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
      await applyMicProcessing()
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
    if (enabled) await applyMicProcessing()
  } catch (err) {
    showToast(`Microfone indisponível: ${errorText(err)}`)
  }
}

function micTrack(): LocalAudioTrack | undefined {
  return room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as
    | LocalAudioTrack
    | undefined
}

/**
 * Opções da captura do microfone. No modo "básico" o filtro do WebRTC faz a supressão; com IA ele fica
 * desligado (junto só piora a voz), e o volume automático também: nas pausas ele subia o ruído de
 * fundo e a IA cortava mais forte justo no começo e no fim das frases. Nesse caso vale o ganho manual.
 */
export function captureOptions(settings: Settings) {
  return {
    noiseSuppression: settings.noiseMode === 'basic',
    echoCancellation: settings.echoCancellation,
    autoGainControl: settings.autoGainControl && !isAiNoise(settings.noiseMode),
  }
}

export function micSettings(settings: Settings): MicSettings {
  const { noiseMode, noiseIntensity, micGainDb, gate } = settings
  return { noiseMode, noiseIntensity, micGainDb, gate }
}

/** Ganho, supressão por IA e noise gate no microfone da call, conforme a configuração. */
async function applyMicProcessing() {
  const track = micTrack()
  if (!track) return
  const mic = micSettings(get().settings)
  const current = track.getProcessor()
  try {
    if (current instanceof MicProcessor) {
      await current.update(mic)
    } else {
      await track.setAudioContext(noiseAudioContext())
      await track.setProcessor(new MicProcessor(mic))
    }
  } catch (err) {
    showToast(`Processamento do microfone indisponível: ${errorText(err)}`)
  }
}

/** Muda ganho, intensidade da IA ou noise gate na hora, mesmo no meio de uma chamada. */
export function updateMicSettings(patch: Partial<Pick<Settings, 'micGainDb' | 'noiseIntensity' | 'gate'>>) {
  updateSettings(patch)
  void applyMicProcessing()
}

/** Troca o modo de supressão de ruído na hora, mesmo no meio de uma chamada. */
export async function setNoiseMode(mode: NoiseMode) {
  const before = captureOptions(get().settings)
  updateSettings({ noiseMode: mode })
  const after = captureOptions(get().settings)
  const track = micTrack()
  if (!track) return
  // filtro do WebRTC e volume automático são configurações da captura: precisa reabrir o microfone
  if (before.noiseSuppression !== after.noiseSuppression || before.autoGainControl !== after.autoGainControl) {
    try {
      await track.restartTrack({ deviceId: get().settings.inputDeviceId || undefined, ...after })
    } catch (err) {
      showToast(`Não foi possível reabrir o microfone: ${errorText(err)}`)
    }
  }
  await applyMicProcessing()
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
  const bitrate = shareBitrate(options.quality, options.hint)
  startBitrateKbps = Math.round((bitrate * 0.6) / 1000)

  const capture = async (audio: boolean) => {
    await window.api.selectScreenSource(sourceId, audio)
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: q.width },
        height: { max: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      },
      audio: audio
        ? ({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // pede ao Chromium para não capturar o som do próprio app (a voz dos amigos)
            restrictOwnAudio: true,
          } as MediaTrackConstraints)
        : false,
    })
  }

  // No Windows o áudio vem do helper nativo, que deixa de fora o som do próprio app (as vozes da
  // call). Sem ele, cai no loopback do Chromium, que pega tudo.
  const helperAudio = options.audio ? await startScreenAudio() : null
  const loopback = options.audio && !helperAudio

  let stream: MediaStream
  try {
    stream = await capture(loopback)
  } catch (err) {
    // o áudio do sistema pode não existir (ex.: macOS antigo): tenta só com o vídeo
    if (!loopback) {
      helperAudio?.stop()
      stopScreenAudio()
      return showToast(`Não foi possível capturar a tela: ${errorText(err)}`)
    }
    try {
      stream = await capture(false)
      showToast('Compartilhando sem o áudio do sistema')
    } catch (err2) {
      return showToast(`Não foi possível capturar a tela: ${errorText(err2)}`)
    }
  }

  if (room !== r) {
    stream.getTracks().forEach((t) => t.stop())
    helperAudio?.stop()
    stopScreenAudio()
    return
  }

  const [video] = stream.getVideoTracks()
  const audio = helperAudio ?? stream.getAudioTracks()[0]
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
      // priority "high": o vídeo da tela passa na frente na fila de envio do WebRTC
      screenShareEncoding: { maxBitrate: bitrate, maxFramerate: q.fps, priority: 'high' },
      // Em jogo, "balanced": sem banda, corta um pouco de resolução e de FPS juntos. Com
      // "maintain-framerate" a resolução despencava e mesmo assim a imagem travava.
      degradationPreference: options.hint === 'motion' ? 'balanced' : 'maintain-resolution',
    })
    if (audio) {
      await r.localParticipant.publishTrack(audio, {
        source: Track.Source.ScreenShareAudio,
        name: 'screen-audio',
        dtx: false,
        red: false,
        forceStereo: true,
        // 96 kbps: Opus estéreo já soa bem para jogo/música e sai do upload uma vez por amigo
        audioPreset: { maxBitrate: SCREEN_AUDIO_BPS },
      })
    }
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    helperAudio?.stop()
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
  stopScreenAudio()
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
