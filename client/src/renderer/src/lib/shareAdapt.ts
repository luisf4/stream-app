import type { LocalVideoTrack } from 'livekit-client'
import { showToast, useStore } from '../store'
import type { ShareHint, ShareQuality, ShareStatus } from './voice'
import { QUALITIES, shareBitrate } from './voice'

/**
 * Qualidade automática da transmissão: a cada 2 s lê as estatísticas do envio e, se o PC (CPU) ou
 * a internet de quem transmite não estiver dando conta, desce um degrau (menos resolução/fps/taxa).
 * Depois de um tempo estável, tenta subir de novo; se o degrau de cima falhar, espera cada vez mais
 * antes de tentar outra vez. Na qualidade fixa só avisa.
 */

const TICK_MS = 2000
/** depois de trocar de degrau, espera o WebRTC se ajustar antes de julgar */
const GRACE_MS = 8000
/** tempo estável antes de tentar subir */
const STABLE_UP_MS = 30_000
/** tempo estável para lembrar o degrau na próxima transmissão */
const STABLE_SAVE_MS = 60_000
const LEVEL_KEY = 'resenha.share.level'

// Do pior para o melhor. Jogo prefere fps; texto prefere resolução.
const LADDERS: Record<ShareHint, ShareQuality[]> = {
  motion: ['480p30', '720p30', '720p60', '1080p60'],
  detail: ['480p30', '720p30', '1080p30', '1080p60'],
}
// codificando pela CPU (sem placa de vídeo), acima disto o jogo e o codificador brigam pelo processador
const SOFTWARE_CEILING: ShareQuality = '720p30'

/** Degrau para começar a transmissão automática: o último que ficou estável, ou 720p30. */
export function initialLevel(hint: ShareHint): ShareQuality {
  const ladder = LADDERS[hint]
  try {
    const saved = localStorage.getItem(`${LEVEL_KEY}.${hint}`) as ShareQuality | null
    if (saved && ladder.includes(saved)) return saved
  } catch {
    // sem localStorage: usa o padrão
  }
  return '720p30'
}

function saveLevel(hint: ShareHint, level: ShareQuality) {
  try {
    localStorage.setItem(`${LEVEL_KEY}.${hint}`, level)
  } catch {
    // tudo bem
  }
}

/** Troca resolução, fps e taxa da transmissão sem republicar. */
export async function applyLevel(track: LocalVideoTrack, quality: ShareQuality, hint: ShareHint) {
  const q = QUALITIES[quality]
  await track.mediaStreamTrack
    .applyConstraints({
      width: { max: q.width },
      height: { max: q.height },
      frameRate: { ideal: q.fps, max: q.fps },
    })
    .catch(() => {})
  await setSenderLimits(track, shareBitrate(quality, hint), q.fps)
}

async function setSenderLimits(track: LocalVideoTrack, bitrate: number, fps: number) {
  const sender = track.sender
  if (!sender) return
  const params = sender.getParameters()
  if (!params.encodings?.length) return
  const same = params.encodings.every((e) => e.maxBitrate === bitrate && e.maxFramerate === fps)
  if (same) return
  for (const e of params.encodings) {
    e.maxBitrate = bitrate
    e.maxFramerate = fps
  }
  await sender.setParameters(params).catch(() => {})
}

interface Sample {
  /** fração do intervalo em que o codificador estava limitado por CPU / por banda */
  cpu: number
  bandwidth: number
  /** 1 = codificou bem menos quadros do que a captura entregou */
  slow: number
  loss: number
}

const problemText = (problem: 'cpu' | 'bandwidth') =>
  problem === 'bandwidth' ? 'Sua internet não está aguentando' : 'Seu PC não está dando conta'

/**
 * Acompanha a transmissão até a função devolvida ser chamada. `auto` = pode trocar de degrau;
 * senão só avisa.
 */
export function monitorShare(
  track: LocalVideoTrack,
  start: ShareQuality,
  hint: ShareHint,
  auto: boolean,
): () => void {
  const ladder = LADDERS[hint]
  let level = start
  let changedAt = performance.now()
  let goodSince = performance.now()
  let saved = false
  let software = false
  let problem: ShareStatus['problem'] = null
  const samples: Sample[] = []
  // degrau -> até quando não tentar subir para ele (e quanto esperar na próxima falha)
  const blocked = new Map<ShareQuality, { until: number; backoff: number }>()
  let prev: { t: number; cpu: number; bandwidth: number } | null = null
  let stopped = false

  const publish = () =>
    useStore.setState({ shareStatus: { quality: level, auto, problem, software } })
  publish()

  const ceiling = () => {
    if (!software) return ladder.length - 1
    return Math.min(ladder.length - 1, Math.max(0, ladder.indexOf(SOFTWARE_CEILING)))
  }

  const move = async (to: ShareQuality, reason: 'cpu' | 'bandwidth' | null) => {
    const from = level
    level = to
    changedAt = performance.now()
    goodSince = changedAt
    saved = false
    samples.length = 0
    await applyLevel(track, to, hint)
    if (reason) {
      // o degrau de onde caiu fica bloqueado: 1 min, depois 2, 4… até 10 min
      const old = blocked.get(from)
      const backoff = Math.min((old?.backoff ?? 30_000) * 2, 600_000)
      blocked.set(from, { until: changedAt + backoff, backoff })
      showToast(`${problemText(reason)}: transmissão em ${QUALITIES[to].label}`)
    }
    publish()
  }

  const tick = async () => {
    const sender = track.sender
    if (!sender) return
    const report = await sender.getStats()
    const all = [...report.values()] as Record<string, any>[]
    const outbound = all
      .filter((s) => s.type === 'outbound-rtp' && s.kind === 'video')
      .sort((a, b) => (b.frameWidth ?? 0) - (a.frameWidth ?? 0))[0]
    if (!outbound) return
    const remote = all.find((s) => s.type === 'remote-inbound-rtp' && s.kind === 'video')
    const source =
      (outbound.mediaSourceId && report.get(outbound.mediaSourceId)) ??
      all.find((s) => s.type === 'media-source' && s.kind === 'video')
    const now = performance.now()

    // OpenH264 = codificando pela CPU; powerEfficientEncoder diz se é a placa de vídeo
    const isSoftware =
      outbound.powerEfficientEncoder === false || /openh264|libvpx/i.test(outbound.encoderImplementation ?? '')
    if (isSoftware !== software) {
      software = isSoftware
      publish()
    }

    const captureFps: number = source?.framesPerSecond ?? 0
    const encodedFps: number = outbound.framesPerSecond ?? 0
    const durations = outbound.qualityLimitationDurations ?? {}
    const cur = { t: now, cpu: durations.cpu ?? 0, bandwidth: durations.bandwidth ?? 0 }
    if (prev) {
      const dt = (cur.t - prev.t) / 1000
      if (dt > 0) {
        samples.push({
          cpu: Math.min(1, (cur.cpu - prev.cpu) / dt),
          bandwidth: Math.min(1, (cur.bandwidth - prev.bandwidth) / dt),
          // tela parada = a captura manda poucos quadros; isso não é problema
          slow: captureFps >= QUALITIES[level].fps * 0.5 && encodedFps < captureFps * 0.7 ? 1 : 0,
          loss: remote?.fractionLost ?? 0,
        })
        if (samples.length > 3) samples.shift()
      }
    }
    prev = cur

    // o LiveKit pode reaplicar os limites originais (ex.: depois de reconectar)
    await setSenderLimits(track, shareBitrate(level, hint), QUALITIES[level].fps)

    if (now - changedAt < GRACE_MS || samples.length < 3) return

    // média dos últimos ~6 s
    const avg = (key: keyof Sample) => samples.reduce((sum, s) => sum + s[key], 0) / samples.length
    const bandwidthBad = avg('bandwidth') > 0.5 || avg('loss') > 0.05
    const cpuBad = avg('cpu') > 0.5 || avg('slow') > 0.5
    const bad: 'cpu' | 'bandwidth' | null = bandwidthBad
      ? avg('cpu') > avg('bandwidth')
        ? 'cpu'
        : 'bandwidth'
      : cpuBad
        ? 'cpu'
        : null

    const index = ladder.indexOf(level)
    if (bad) {
      goodSince = now
      if (auto && index > 0) return move(ladder[index - 1], bad)
      if (problem !== bad) {
        problem = bad
        publish()
      }
      return
    }

    if (problem && now - goodSince > 10_000) {
      problem = null
      publish()
    }
    // codificador por CPU acima do teto: desce sem esperar falhar
    if (auto && index > ceiling()) return move(ladder[ceiling()], 'cpu')
    if (!saved && auto && now - goodSince > STABLE_SAVE_MS) {
      saved = true
      saveLevel(hint, level)
    }
    const next = ladder[index + 1]
    if (auto && next && index + 1 <= ceiling() && now - goodSince > STABLE_UP_MS) {
      if ((blocked.get(next)?.until ?? 0) <= now) await move(next, null)
    }
  }

  let running = false
  const timer = setInterval(() => {
    if (running || stopped) return
    running = true
    tick()
      .catch(() => {})
      .finally(() => {
        running = false
      })
  }, TICK_MS)

  return () => {
    stopped = true
    clearInterval(timer)
    useStore.setState({ shareStatus: null })
  }
}
