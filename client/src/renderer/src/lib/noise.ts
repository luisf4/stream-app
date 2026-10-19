import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
// Embutidos no bundle: no app instalado a página vem de file://, onde fetch() de arquivos é bloqueado.
// Só a versão SIMD: o Chromium do Electron sempre suporta, e economiza ~200 KB.
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?inline'
import rnnoiseWorkletSource from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?raw'
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client'

/**
 * Supressão de ruído com RNNoise (rede neural que roda no próprio PC): tira teclado,
 * ventilador, barulho de rua etc. Usado como "processador" do microfone no LiveKit.
 */

let audioContext: AudioContext | null = null
let wasmBinary: Promise<ArrayBuffer> | null = null
let workletReady: Promise<void> | null = null

/** O RNNoise trabalha a 48 kHz. */
export function noiseAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext({ sampleRate: 48_000 })
    workletReady = null
  }
  return audioContext
}

async function prepare(ctx: AudioContext): Promise<ArrayBuffer> {
  wasmBinary ??= loadRnnoise({ url: rnnoiseSimdWasm, simdUrl: rnnoiseSimdWasm })
  workletReady ??= (async () => {
    const url = URL.createObjectURL(new Blob([rnnoiseWorkletSource], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
  })()
  const [binary] = await Promise.all([wasmBinary, workletReady])
  return binary
}

export class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'rnnoise'
  processedTrack?: MediaStreamTrack

  private source?: MediaStreamAudioSourceNode
  private node?: RnnoiseWorkletNode
  private destination?: MediaStreamAudioDestinationNode

  async init({ track, audioContext: ctx }: AudioProcessorOptions) {
    const binary = await prepare(ctx)
    if (ctx.state === 'suspended') await ctx.resume()
    this.source = ctx.createMediaStreamSource(new MediaStream([track]))
    this.node = new RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 })
    this.destination = ctx.createMediaStreamDestination()
    this.source.connect(this.node).connect(this.destination)
    this.processedTrack = this.destination.stream.getAudioTracks()[0]
  }

  async restart(opts: AudioProcessorOptions) {
    this.teardown()
    await this.init(opts)
  }

  async destroy() {
    this.teardown()
  }

  private teardown(): void {
    this.source?.disconnect()
    this.node?.disconnect()
    this.node?.destroy()
    this.processedTrack?.stop()
    this.source = this.node = this.destination = this.processedTrack = undefined
  }
}

/**
 * Teste de microfone: toca de volta no fone o que o microfone capta, já com o modo de supressão
 * escolhido, e informa o volume (0–1) para desenhar a barrinha. Retorna a função que para o teste.
 */
export async function startMicTest(
  options: {
    deviceId: string
    mode: 'off' | 'basic' | 'ai'
    echoCancellation: boolean
    autoGainControl: boolean
    outputDeviceId: string
  },
  onLevel: (level: number) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: options.deviceId && options.deviceId !== 'default' ? { exact: options.deviceId } : undefined,
      noiseSuppression: options.mode === 'basic',
      echoCancellation: options.echoCancellation,
      autoGainControl: options.autoGainControl,
    },
  })
  const [input] = stream.getAudioTracks()
  const ctx = noiseAudioContext()
  if (ctx.state === 'suspended') await ctx.resume()
  const sinkCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
  if (sinkCtx.setSinkId && options.outputDeviceId) {
    await sinkCtx.setSinkId(options.outputDeviceId === 'default' ? '' : options.outputDeviceId).catch(() => {})
  }

  let processor: RnnoiseProcessor | undefined
  let track = input
  if (options.mode === 'ai') {
    processor = new RnnoiseProcessor()
    await processor.init({ kind: 'audio', track: input, audioContext: ctx } as AudioProcessorOptions)
    track = processor.processedTrack ?? input
  }

  const source = ctx.createMediaStreamSource(new MediaStream([track]))
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  source.connect(ctx.destination)

  const samples = new Float32Array(analyser.fftSize)
  let frame = 0
  const tick = () => {
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const s of samples) sum += s * s
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4))
    frame = requestAnimationFrame(tick)
  }
  tick()

  return () => {
    cancelAnimationFrame(frame)
    source.disconnect()
    analyser.disconnect()
    void processor?.destroy()
    input.stop()
    onLevel(0)
  }
}
