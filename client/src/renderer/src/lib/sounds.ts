// Sons curtos gerados na hora (sem arquivos de áudio).
let ctx: AudioContext | null = null

function tone(freqs: number[], duration = 0.09, volume = 0.08) {
  ctx ??= new AudioContext()
  const start = ctx.currentTime
  freqs.forEach((freq, i) => {
    const osc = ctx!.createOscillator()
    const gain = ctx!.createGain()
    const t = start + i * duration
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(volume, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)
    osc.connect(gain).connect(ctx!.destination)
    osc.start(t)
    osc.stop(t + duration + 0.02)
  })
}

export const sounds = {
  join: () => tone([523, 784]),
  leave: () => tone([784, 523]),
  mute: () => tone([440], 0.07),
  unmute: () => tone([660], 0.07),
  message: () => tone([880, 1175], 0.07, 0.05),
}
