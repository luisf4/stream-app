/**
 * Áudio do sistema para a stream SEM as vozes da call (só Windows).
 * O processo principal roda o helper nativo, que manda PCM float32 48 kHz estéreo; aqui ele vira
 * uma MediaStreamTrack via AudioWorklet, publicada no lugar do loopback do getDisplayMedia().
 */

const RATE = 48_000
const workletSource = `
const RATE = ${RATE}
// em amostras intercaladas (2 por quadro), sempre pares
const MAX_QUEUE = ${RATE * 2 * 15 / 100}
const TARGET_QUEUE = ${RATE * 2 * 6 / 100}
const PREBUFFER = ${RATE * 2 * 4 / 100}
class ScreenAudioPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = RATE * 2 // 1 s estéreo intercalado
    this.buf = new Float32Array(this.size)
    this.read = 0
    this.write = 0
    this.count = 0
    this.playing = false
    this.port.onmessage = (e) => this.push(e.data)
  }
  push(data) {
    for (let i = 0; i < data.length; i++) {
      this.buf[this.write] = data[i]
      this.write = (this.write + 1) % this.size
    }
    this.count += data.length
    // não deixa o atraso crescer: passou de 150 ms na fila, pula para 60 ms
    if (this.count > MAX_QUEUE) {
      const drop = this.count - TARGET_QUEUE
      this.read = (this.read + drop) % this.size
      this.count -= drop
    }
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0]
    // espera juntar 40 ms antes de tocar, para engolir a variação de chegada dos pacotes
    if (!this.playing && this.count >= PREBUFFER) this.playing = true
    for (let i = 0; i < left.length; i++) {
      if (this.playing && this.count >= 2) {
        left[i] = this.buf[this.read]
        right[i] = this.buf[this.read + 1]
        this.read = (this.read + 2) % this.size
        this.count -= 2
      } else {
        left[i] = 0
        right[i] = 0
        this.playing = false
      }
    }
    return true
  }
}
registerProcessor('screen-audio-player', ScreenAudioPlayer)
`

let context: AudioContext | null = null
let unsubscribe: (() => void) | null = null

/** Começa a captura; null quando não dá (fora do Windows, Windows antigo, helper ausente). */
export async function startScreenAudio(): Promise<MediaStreamTrack | null> {
  stopScreenAudio()
  if (!(await window.api.startScreenAudio())) return null

  const ctx = new AudioContext({ sampleRate: RATE })
  context = ctx
  try {
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    if (context !== ctx) return null

    const node = new AudioWorkletNode(ctx, 'screen-audio-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    const destination = ctx.createMediaStreamDestination()
    destination.channelCount = 2
    node.connect(destination)
    if (ctx.state === 'suspended') await ctx.resume()

    unsubscribe = window.api.onScreenAudio((pcm) => {
      const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
      node.port.postMessage(samples, [samples.buffer])
    })
    return destination.stream.getAudioTracks()[0]
  } catch {
    if (context === ctx) stopScreenAudio()
    return null
  }
}

export function stopScreenAudio() {
  unsubscribe?.()
  unsubscribe = null
  context?.close().catch(() => {})
  context = null
  window.api.stopScreenAudio()
}
