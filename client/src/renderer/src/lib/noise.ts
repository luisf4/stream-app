import { GtcrnWorkletNode, loadGtcrn, loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?inline'
import gtcrnWorkletSource from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?raw'
// Embutidos no bundle: no app instalado a página vem de file://, onde fetch() de arquivos é bloqueado.
// Só a versão SIMD: o Chromium do Electron sempre suporta, e economiza ~200 KB.
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?inline'
import rnnoiseWorkletSource from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?raw'
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client'
import type { GateSettings, NoiseIntensity, NoiseMode } from './settings'

/**
 * Processamento do microfone, usado na call (como "processador" do LiveKit) e no teste de microfone:
 *
 *   mic → ganho → supressão de ruído (IA) → noise gate → saída
 *
 * A IA sozinha zera tudo que acha que é ruído e cortava o começo e o fim das frases. Por isso uma
 * pequena parte do som original volta junto (conforme a intensidade): o ruído continua baixo, mas as
 * bordas das palavras não somem.
 */

export interface MicSettings {
  noiseMode: NoiseMode
  noiseIntensity: NoiseIntensity
  micGainDb: number
  gate: GateSettings
}

const RATE = 48_000
const dbToGain = (db: number) => 10 ** (db / 20)

/** quanto do som original volta junto com o da IA (= o máximo que a IA consegue abaixar o ruído) */
const DRY_LEVEL: Record<NoiseIntensity, number> = {
  low: dbToGain(-15),
  medium: dbToGain(-25),
  high: dbToGain(-40),
}

/**
 * Atraso de cada IA, para alinhar o som original com o processado (senão vira efeito "flanger").
 * Medido por correlação entre entrada e saída dos worklets (OfflineAudioContext, 48 kHz).
 */
const DENOISER_LATENCY: Record<'ai' | 'ai2', number> = {
  ai: 992 / RATE,
  ai2: 1530 / RATE,
}

let audioContext: AudioContext | null = null
const modulesReady = new WeakMap<BaseAudioContext, Promise<void>>()
let rnnoiseBinary: Promise<ArrayBuffer> | null = null
let gtcrnBinary: Promise<ArrayBuffer> | null = null

/** O RNNoise trabalha a 48 kHz. */
export function noiseAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContext({ sampleRate: RATE })
  return audioContext
}

async function addModule(ctx: BaseAudioContext, source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function prepare(ctx: BaseAudioContext): Promise<void> {
  let ready = modulesReady.get(ctx)
  if (!ready) {
    ready = Promise.all([
      addModule(ctx, rnnoiseWorkletSource),
      addModule(ctx, gtcrnWorkletSource),
      addModule(ctx, gateWorkletSource),
    ]).then(() => undefined)
    ready.catch(() => modulesReady.delete(ctx))
    modulesReady.set(ctx, ready)
  }
  return ready
}

// ---------- noise gate ----------
// O gate do pacote liga/desliga de uma vez e cortaria as palavras. Este:
// - olha 10 ms à frente (o áudio sai 10 ms atrasado), então abre antes da palavra começar;
// - abre em 2 ms, segura 300 ms depois da fala e fecha suave em ~150 ms;
// - fecha 6 dB abaixo do limiar de abertura (não fica abrindo/fechando na borda);
// - fechado abaixa 40 dB em vez de mutar de vez.
// Também mede o nível (antes do gate) para a barrinha das configurações.
const gateWorkletSource = `
const dbToGain = (db) => 10 ** (db / 20)
class ResenhaGate extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.lookahead = Math.round(sampleRate * 0.01)
    this.delay = new Float32Array(this.lookahead)
    this.delayIndex = 0
    this.floor = dbToGain(-40)
    this.attackStep = 1 / (sampleRate * 0.002)
    this.releaseCoef = Math.exp(-1 / (sampleRate * 0.05))
    this.holdSamples = Math.round(sampleRate * 0.3)
    this.hold = 0
    this.isOpen = false
    this.gain = 1
    this.meterEvery = Math.round(sampleRate * 0.05)
    this.meterCount = 0
    this.meterPeak = 0
    this.meterOpen = false
    this.set(options.processorOptions)
    this.port.onmessage = (e) => this.set(e.data)
  }
  set({ enabled, thresholdDb }) {
    this.enabled = enabled
    this.openLevel = dbToGain(thresholdDb)
    this.closeLevel = dbToGain(thresholdDb - 6)
  }
  process(inputs, outputs) {
    const input = inputs[0][0]
    const output = outputs[0][0]
    if (!input) {
      output.fill(0)
      return true
    }
    let sum = 0
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
    const level = Math.sqrt(sum / input.length)

    if (level > this.openLevel || (this.isOpen && level > this.closeLevel)) {
      this.isOpen = true
      this.hold = this.holdSamples
    } else if (this.hold > 0) {
      this.hold -= input.length
    } else {
      this.isOpen = false
    }

    const target = !this.enabled || this.isOpen ? 1 : this.floor
    for (let i = 0; i < input.length; i++) {
      const delayed = this.delay[this.delayIndex]
      this.delay[this.delayIndex] = input[i]
      this.delayIndex = (this.delayIndex + 1) % this.lookahead
      if (this.gain < target) this.gain = Math.min(target, this.gain + this.attackStep)
      else if (this.gain > target) this.gain = Math.max(target, this.gain * this.releaseCoef)
      output[i] = (this.enabled ? delayed : input[i]) * this.gain
    }

    this.meterPeak = Math.max(this.meterPeak, level)
    this.meterOpen = this.meterOpen || !this.enabled || this.isOpen
    this.meterCount += input.length
    if (this.meterCount >= this.meterEvery) {
      this.port.postMessage({ db: 20 * Math.log10(this.meterPeak + 1e-9), open: this.meterOpen })
      this.meterCount = 0
      this.meterPeak = 0
      this.meterOpen = false
    }
    return true
  }
}
registerProcessor('resenha-gate', ResenhaGate)
`

// ---------- processador ----------

type Denoiser = AudioWorkletNode & { destroy(): void }

function mono<T extends AudioNode>(node: T): T {
  node.channelCount = 1
  node.channelCountMode = 'explicit'
  node.channelInterpretation = 'speakers'
  return node
}

export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'mic'
  processedTrack?: MediaStreamTrack
  /** nível do microfone em dB (depois do ganho e da IA) e se o gate está aberto, ~20× por segundo */
  onMeter?: (db: number, open: boolean) => void

  private ctx?: AudioContext
  private source?: MediaStreamAudioSourceNode
  private input?: GainNode
  private dryDelay?: DelayNode
  private dry?: GainNode
  private mix?: GainNode
  private gate?: AudioWorkletNode
  private destination?: MediaStreamAudioDestinationNode
  private denoiser?: Denoiser
  private denoiserMode: NoiseMode = 'off'

  constructor(private settings: MicSettings) {}

  async init({ track, audioContext: ctx }: AudioProcessorOptions) {
    await prepare(ctx)
    if (ctx.state === 'suspended') await ctx.resume()
    this.ctx = ctx
    this.source = ctx.createMediaStreamSource(new MediaStream([track]))
    // a voz é mono: com microfone estéreo, o RNNoise deixava o canal direito mudo
    this.input = mono(ctx.createGain())
    this.dryDelay = mono(ctx.createDelay(0.1))
    this.dry = mono(ctx.createGain())
    this.mix = mono(ctx.createGain())
    this.gate = mono(
      new AudioWorkletNode(ctx, 'resenha-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: this.settings.gate,
      }),
    )
    this.gate.port.onmessage = (e: MessageEvent<{ db: number; open: boolean }>) =>
      this.onMeter?.(e.data.db, e.data.open)
    this.destination = ctx.createMediaStreamDestination()

    this.source.connect(this.input)
    this.input.connect(this.dryDelay).connect(this.dry).connect(this.mix)
    this.mix.connect(this.gate).connect(this.destination)
    this.processedTrack = this.destination.stream.getAudioTracks()[0]
    await this.update(this.settings)
  }

  /** Aplica configurações novas na hora, sem reabrir o microfone. */
  async update(settings: MicSettings) {
    this.settings = settings
    const ctx = this.ctx
    if (!ctx || !this.input || !this.dry || !this.dryDelay || !this.mix || !this.gate) return
    const now = ctx.currentTime
    this.input.gain.setTargetAtTime(dbToGain(settings.micGainDb), now, 0.02)
    this.gate.port.postMessage(settings.gate)

    const mode = settings.noiseMode === 'ai' || settings.noiseMode === 'ai2' ? settings.noiseMode : 'off'
    if (mode !== this.denoiserMode) {
      this.removeDenoiser()
      if (mode !== 'off') {
        const node = mono(
          mode === 'ai'
            ? new RnnoiseWorkletNode(ctx, { wasmBinary: await loadRnnoiseBinary(), maxChannels: 1 })
            : new GtcrnWorkletNode(ctx, { wasmBinary: await loadGtcrnBinary(), maxChannels: 1 }),
        )
        // pode ter sido desmontado ou trocado enquanto o wasm carregava
        if (this.ctx !== ctx || this.settings !== settings) {
          node.destroy()
          return
        }
        this.input.connect(node).connect(this.mix)
        this.denoiser = node
        this.dryDelay.delayTime.value = DENOISER_LATENCY[mode]
      } else {
        this.dryDelay.delayTime.value = 0
      }
      this.denoiserMode = mode
    }
    this.dry.gain.setTargetAtTime(mode === 'off' ? 1 : DRY_LEVEL[settings.noiseIntensity], now, 0.02)
  }

  async restart(opts: AudioProcessorOptions) {
    this.teardown()
    await this.init(opts)
  }

  async destroy() {
    this.teardown()
  }

  private removeDenoiser() {
    this.denoiser?.disconnect()
    this.denoiser?.destroy()
    this.denoiser = undefined
    this.denoiserMode = 'off'
  }

  private teardown(): void {
    this.removeDenoiser()
    for (const node of [this.source, this.input, this.dryDelay, this.dry, this.mix, this.gate]) node?.disconnect()
    if (this.gate) this.gate.port.onmessage = null
    this.processedTrack?.stop()
    this.ctx = this.source = this.input = this.dryDelay = this.dry = this.mix = this.gate = undefined
    this.destination = this.processedTrack = undefined
  }
}

function loadRnnoiseBinary() {
  rnnoiseBinary ??= loadRnnoise({ url: rnnoiseSimdWasm, simdUrl: rnnoiseSimdWasm })
  return rnnoiseBinary
}

function loadGtcrnBinary() {
  gtcrnBinary ??= loadGtcrn({ url: gtcrnWasm })
  return gtcrnBinary
}

/**
 * Teste de microfone: toca de volta no fone o que o microfone capta, com o mesmo processamento da
 * call, e informa o nível em dB e se o gate está aberto. Retorna como atualizar e parar o teste.
 */
export async function startMicTest(
  options: {
    deviceId: string
    mic: MicSettings
    echoCancellation: boolean
    autoGainControl: boolean
    outputDeviceId: string
  },
  onMeter: (db: number, open: boolean) => void,
): Promise<{ update: (mic: MicSettings) => void; stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: options.deviceId && options.deviceId !== 'default' ? { exact: options.deviceId } : undefined,
      noiseSuppression: options.mic.noiseMode === 'basic',
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

  const processor = new MicProcessor(options.mic)
  processor.onMeter = onMeter
  try {
    await processor.init({ kind: 'audio', track: input, audioContext: ctx } as AudioProcessorOptions)
  } catch (err) {
    input.stop()
    throw err
  }
  const source = ctx.createMediaStreamSource(new MediaStream([processor.processedTrack!]))
  source.connect(ctx.destination)

  return {
    update: (mic) => void processor.update(mic),
    stop: () => {
      source.disconnect()
      void processor.destroy()
      input.stop()
      onMeter(-100, false)
    },
  }
}
