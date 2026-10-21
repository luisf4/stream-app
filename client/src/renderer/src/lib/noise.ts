import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
// Embutidos no bundle: no app instalado a página vem de file://, onde fetch() de arquivos é bloqueado.
// Só a versão SIMD: o Chromium do Electron sempre suporta, e economiza ~200 KB.
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?inline'
import rnnoiseWorkletSource from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?raw'
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client'
import type { GateSettings } from './settings'

/**
 * Processamento do microfone, usado na call (como "processador" do LiveKit) e no teste de microfone:
 *
 *   mic → supressão de ruído (RNNoise) → noise gate + volume automático → limitador → saída
 *
 * A IA sozinha zera tudo que acha que é ruído e cortava o começo e o fim das frases. Por isso um
 * pouco do som original (−25 dB) volta junto: o ruído continua baixo, mas as palavras não perdem as
 * bordas.
 */

export interface MicSettings {
  noiseSuppression: boolean
  autoGain: boolean
  gate: GateSettings
}

/** Opções da captura do microfone: o RNNoise e o volume automático daqui fazem o resto. */
export const captureOptions = {
  echoCancellation: true,
  // o filtro do navegador junto com a IA só piora a voz
  noiseSuppression: false,
  // o do navegador mexe no volume do microfone do Windows e aumentava o ruído nas pausas
  autoGainControl: false,
}

const RATE = 48_000
const dbToGain = (db: number) => 10 ** (db / 20)
const DRY_LEVEL = dbToGain(-25)
/** atraso do RNNoise, para alinhar o som original com o processado (senão vira efeito "flanger") */
const RNNOISE_LATENCY = 992 / RATE

let audioContext: AudioContext | null = null
const modulesReady = new WeakMap<BaseAudioContext, Promise<void>>()
let rnnoiseBinary: Promise<ArrayBuffer> | null = null

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
    ready = Promise.all([addModule(ctx, rnnoiseWorkletSource), addModule(ctx, voiceWorkletSource)]).then(
      () => undefined,
    )
    ready.catch(() => modulesReady.delete(ctx))
    modulesReady.set(ctx, ready)
  }
  return ready
}

// ---------- noise gate + volume automático ----------
// Detector de voz: o nível do bloco passa do limiar (o do gate, ou −55 dB com o gate desligado).
// - olha 10 ms à frente (o áudio sai 10 ms atrasado), então abre antes da palavra começar;
// - abre em 2 ms, segura 300 ms depois da fala e fecha suave em ~150 ms;
// - fecha 6 dB abaixo do limiar de abertura (não fica abrindo/fechando na borda).
// Gate: fechado abaixa 40 dB em vez de mutar de vez.
// Volume automático: só aprende enquanto a pessoa fala (e bem acima do ruído de fundo), então nunca
// aumenta o ruído nas pausas. Leva a média da fala para −20 dB, com ganho entre −10 e +20 dB; sobe
// devagar (6 dB/s) e desce rápido (30 dB/s), e o ganho muda amostra a amostra, sem degraus.
// Também mede o nível (antes do ganho) para a barrinha das configurações.
export const voiceWorkletSource = `
const dbToGain = (db) => 10 ** (db / 20)
const toDb = (gain) => 20 * Math.log10(gain + 1e-9)
class ResenhaVoice extends AudioWorkletProcessor {
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
    this.gateGain = 1
    // volume automático
    this.targetDb = -20
    this.minDb = -10
    this.maxDb = 20
    this.upDbPerSec = 6
    this.downDbPerSec = 30
    this.speechPower = dbToGain(this.targetDb) ** 2
    this.gainDb = 0
    this.agcGain = 1
    this.noiseFloor = dbToGain(-60)
    this.meterEvery = Math.round(sampleRate * 0.05)
    this.meterCount = 0
    this.meterPeak = 0
    this.meterOpen = false
    this.set(options.processorOptions)
    this.port.onmessage = (e) => this.set(e.data)
  }
  set({ gate, autoGain }) {
    this.gateEnabled = gate.enabled
    const threshold = gate.enabled ? gate.thresholdDb : -55
    this.openLevel = dbToGain(threshold)
    this.closeLevel = dbToGain(threshold - 6)
    this.autoGain = autoGain
  }
  process(inputs, outputs) {
    const input = inputs[0][0]
    const output = outputs[0][0]
    if (!input) {
      output.fill(0)
      return true
    }
    const n = input.length
    const blockSec = n / sampleRate
    let sum = 0
    for (let i = 0; i < n; i++) sum += input[i] * input[i]
    const power = sum / n
    const level = Math.sqrt(power)

    const speaking = level > this.openLevel
    if (speaking || (this.isOpen && level > this.closeLevel)) {
      this.isOpen = true
      this.hold = this.holdSamples
    } else if (this.hold > 0) {
      this.hold -= n
    } else {
      this.isOpen = false
    }

    // ruído de fundo: segue o mínimo rápido e sobe devagar (3 dB/s)
    this.noiseFloor = level < this.noiseFloor ? level : this.noiseFloor * dbToGain(3 * blockSec)

    let targetGainDb = 0
    if (this.autoGain) {
      if (speaking && level > this.noiseFloor * dbToGain(15)) {
        const alpha = 1 - Math.exp(-blockSec / 0.3)
        this.speechPower += alpha * (power - this.speechPower)
      }
      const wanted = this.targetDb - 10 * Math.log10(this.speechPower + 1e-12)
      targetGainDb = Math.min(this.maxDb, Math.max(this.minDb, wanted))
    }
    const step = (targetGainDb > this.gainDb ? this.upDbPerSec : this.downDbPerSec) * blockSec
    this.gainDb += Math.max(-step, Math.min(step, targetGainDb - this.gainDb))
    const fromGain = this.agcGain
    const toGain = dbToGain(this.gainDb)
    this.agcGain = toGain

    const gateTarget = !this.gateEnabled || this.isOpen ? 1 : this.floor
    for (let i = 0; i < n; i++) {
      const delayed = this.delay[this.delayIndex]
      this.delay[this.delayIndex] = input[i]
      this.delayIndex = (this.delayIndex + 1) % this.lookahead
      if (this.gateGain < gateTarget) this.gateGain = Math.min(gateTarget, this.gateGain + this.attackStep)
      else if (this.gateGain > gateTarget) this.gateGain = Math.max(gateTarget, this.gateGain * this.releaseCoef)
      const agc = fromGain + ((toGain - fromGain) * (i + 1)) / n
      output[i] = delayed * this.gateGain * agc
    }

    this.meterPeak = Math.max(this.meterPeak, level)
    this.meterOpen = this.meterOpen || !this.gateEnabled || this.isOpen
    this.meterCount += n
    if (this.meterCount >= this.meterEvery) {
      this.port.postMessage({ db: toDb(this.meterPeak), open: this.meterOpen, gainDb: this.gainDb })
      this.meterCount = 0
      this.meterPeak = 0
      this.meterOpen = false
    }
    return true
  }
}
registerProcessor('resenha-voice', ResenhaVoice)
`

// ---------- processador ----------

type Denoiser = AudioWorkletNode & { destroy(): void }

function mono<T extends AudioNode>(node: T): T {
  node.channelCount = 1
  node.channelCountMode = 'explicit'
  node.channelInterpretation = 'speakers'
  return node
}

export interface MicMeter {
  /** nível do microfone em dB (depois da supressão, antes do volume automático) */
  db: number
  /** gate aberto (ou desligado) */
  open: boolean
  /** ganho atual do volume automático, em dB */
  gainDb: number
}

export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'mic'
  processedTrack?: MediaStreamTrack
  /** ~20× por segundo */
  onMeter?: (meter: MicMeter) => void

  private ctx?: AudioContext
  private source?: MediaStreamAudioSourceNode
  private input?: GainNode
  private dryDelay?: DelayNode
  private dry?: GainNode
  private mix?: GainNode
  private voice?: AudioWorkletNode
  private limiter?: DynamicsCompressorNode
  private destination?: MediaStreamAudioDestinationNode
  private denoiser?: Denoiser

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
    this.voice = mono(
      new AudioWorkletNode(ctx, 'resenha-voice', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: this.workletOptions(this.settings),
      }),
    )
    this.voice.port.onmessage = (e: MessageEvent<MicMeter>) => this.onMeter?.(e.data)
    // só segura picos (grito, risada) para não estourar; o volume normal fica com o automático
    this.limiter = mono(ctx.createDynamicsCompressor())
    this.limiter.threshold.value = -6
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.1
    this.destination = ctx.createMediaStreamDestination()

    this.source.connect(this.input)
    this.input.connect(this.dryDelay).connect(this.dry).connect(this.mix)
    this.mix.connect(this.voice).connect(this.limiter).connect(this.destination)
    this.processedTrack = this.destination.stream.getAudioTracks()[0]
    await this.update(this.settings)
  }

  /** Aplica configurações novas na hora, sem reabrir o microfone. */
  async update(settings: MicSettings) {
    this.settings = settings
    const ctx = this.ctx
    if (!ctx || !this.input || !this.dry || !this.dryDelay || !this.mix || !this.voice) return
    this.voice.port.postMessage(this.workletOptions(settings))

    if (settings.noiseSuppression && !this.denoiser) {
      const node = mono(new RnnoiseWorkletNode(ctx, { wasmBinary: await loadRnnoiseBinary(), maxChannels: 1 }))
      // pode ter sido desmontado ou trocado enquanto o wasm carregava
      if (this.ctx !== ctx || this.settings !== settings) {
        node.destroy()
        return
      }
      this.input.connect(node).connect(this.mix)
      this.denoiser = node
      this.dryDelay.delayTime.value = RNNOISE_LATENCY
    } else if (!settings.noiseSuppression && this.denoiser) {
      this.removeDenoiser()
      this.dryDelay.delayTime.value = 0
    }
    this.dry.gain.setTargetAtTime(this.denoiser ? DRY_LEVEL : 1, ctx.currentTime, 0.02)
  }

  async restart(opts: AudioProcessorOptions) {
    this.teardown()
    await this.init(opts)
  }

  async destroy() {
    this.teardown()
  }

  private workletOptions({ gate, autoGain }: MicSettings) {
    return { gate, autoGain }
  }

  private removeDenoiser() {
    this.denoiser?.disconnect()
    this.denoiser?.destroy()
    this.denoiser = undefined
  }

  private teardown(): void {
    this.removeDenoiser()
    for (const node of [this.source, this.input, this.dryDelay, this.dry, this.mix, this.voice, this.limiter]) {
      node?.disconnect()
    }
    if (this.voice) this.voice.port.onmessage = null
    this.processedTrack?.stop()
    this.ctx = this.source = this.input = this.dryDelay = this.dry = this.mix = undefined
    this.voice = this.limiter = this.destination = this.processedTrack = undefined
  }
}

function loadRnnoiseBinary() {
  rnnoiseBinary ??= loadRnnoise({ url: rnnoiseSimdWasm, simdUrl: rnnoiseSimdWasm })
  return rnnoiseBinary
}

/**
 * Teste de microfone: toca de volta no fone o que o microfone capta, com o mesmo processamento da
 * call, e informa o nível. Retorna como atualizar e parar o teste.
 */
export async function startMicTest(
  options: { deviceId: string; mic: MicSettings; outputDeviceId: string },
  onMeter: (meter: MicMeter) => void,
): Promise<{ update: (mic: MicSettings) => void; stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: options.deviceId && options.deviceId !== 'default' ? { exact: options.deviceId } : undefined,
      ...captureOptions,
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
      onMeter({ db: -100, open: false, gainDb: 0 })
    },
  }
}
