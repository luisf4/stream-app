import type { Track } from 'livekit-client'
import { useEffect, useRef, useState } from 'react'

interface Stats {
  direction: 'envio' | 'recebimento'
  resolution?: string
  fps?: number
  bitrateKbps?: number
  codec?: string
  encoder?: string
  hardware?: boolean
  limitation?: string
  connection?: string
  rttMs?: number
  lossPct?: number
  dropped?: number
  jitterMs?: number
}

const LIMITATION: Record<string, string> = {
  none: 'nenhuma',
  cpu: 'CPU (o PC não dá conta de codificar)',
  bandwidth: 'banda (internet de quem transmite)',
  other: 'outra',
}

/** Lê as estatísticas brutas do WebRTC do vídeo (envio para a própria tela, recebimento para os outros). */
async function readStats(track: Track, prev: Map<string, number>): Promise<Stats | null> {
  const t = track as Track & { sender?: RTCRtpSender; receiver?: RTCRtpReceiver }
  const report = t.sender ? await t.sender.getStats() : t.receiver ? await t.receiver.getStats() : null
  if (!report) return null

  const all = [...report.values()] as Record<string, any>[]
  const byId = (id: string | undefined) => (id ? report.get(id) : undefined) as Record<string, any> | undefined
  const now = performance.now()
  const rate = (key: string, bytes: number) => {
    const last = prev.get(key)
    const lastT = prev.get(`${key}:t`)
    prev.set(key, bytes)
    prev.set(`${key}:t`, now)
    return last !== undefined && lastT ? Math.round(((bytes - last) * 8) / (now - lastT)) : undefined
  }

  // com simulcast pode haver várias camadas; a maior é a que importa
  const outbound = all
    .filter((s) => s.type === 'outbound-rtp' && s.kind === 'video')
    .sort((a, b) => (b.frameWidth ?? 0) - (a.frameWidth ?? 0))[0]
  const inbound = all.find((s) => s.type === 'inbound-rtp' && s.kind === 'video')
  const rtp = outbound ?? inbound
  if (!rtp) return null

  const pair =
    all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') ??
    all.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded')
  const local = byId(pair?.localCandidateId)
  const connection = local
    ? local.candidateType === 'relay'
      ? `TURN via ${String(local.relayProtocol ?? '?').toUpperCase()}`
      : `${local.candidateType} ${String(local.protocol ?? '').toUpperCase()}`
    : undefined
  const codec = byId(rtp.codecId)?.mimeType?.replace('video/', '')

  if (outbound) {
    const remote = all.find((s) => s.type === 'remote-inbound-rtp' && s.kind === 'video')
    return {
      direction: 'envio',
      resolution: outbound.frameWidth ? `${outbound.frameWidth}x${outbound.frameHeight}` : undefined,
      fps: outbound.framesPerSecond,
      bitrateKbps: rate('out', outbound.bytesSent ?? 0),
      codec,
      encoder: outbound.encoderImplementation,
      hardware: outbound.powerEfficientEncoder,
      limitation: LIMITATION[outbound.qualityLimitationReason] ?? outbound.qualityLimitationReason,
      connection,
      rttMs: pair?.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : undefined,
      lossPct: remote?.fractionLost !== undefined ? Math.round(remote.fractionLost * 1000) / 10 : undefined,
    }
  }

  if (!inbound) return null
  const received = (inbound.packetsReceived ?? 0) + (inbound.packetsLost ?? 0)
  return {
    direction: 'recebimento',
    resolution: inbound.frameWidth ? `${inbound.frameWidth}x${inbound.frameHeight}` : undefined,
    fps: inbound.framesPerSecond,
    bitrateKbps: rate('in', inbound.bytesReceived ?? 0),
    codec,
    encoder: inbound.decoderImplementation,
    hardware: inbound.powerEfficientDecoder,
    connection,
    rttMs: pair?.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : undefined,
    lossPct: received ? Math.round(((inbound.packetsLost ?? 0) / received) * 1000) / 10 : undefined,
    dropped: inbound.framesDropped,
    jitterMs: inbound.jitter !== undefined ? Math.round(inbound.jitter * 1000) : undefined,
  }
}

export function StreamStats({ track }: { track: Track }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const prev = useRef(new Map<string, number>())

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const s = await readStats(track, prev.current)
        if (alive) setStats(s)
      } catch {
        // track saiu enquanto lia
      }
    }
    void tick()
    const timer = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [track])

  if (!stats) return <div className="stream-stats">carregando estatísticas…</div>

  const row = (label: string, value: string | number | undefined) =>
    value === undefined || value === '' ? null : (
      <div>
        <span>{label}</span>
        <b>{value}</b>
      </div>
    )

  return (
    <div className="stream-stats" onClick={(e) => e.stopPropagation()}>
      {row('Direção', stats.direction)}
      {row('Resolução', stats.resolution)}
      {row('FPS', stats.fps)}
      {row('Taxa', stats.bitrateKbps !== undefined ? `${(stats.bitrateKbps / 1000).toFixed(2)} Mbps` : undefined)}
      {row('Codec', stats.codec)}
      {row(
        stats.direction === 'envio' ? 'Codificador' : 'Decodificador',
        stats.encoder
          ? `${stats.encoder}${stats.hardware === undefined ? '' : stats.hardware ? ' (placa de vídeo)' : ' (CPU)'}`
          : undefined,
      )}
      {row('Limitado por', stats.limitation)}
      {row('Conexão', stats.connection)}
      {row('Latência', stats.rttMs !== undefined ? `${stats.rttMs} ms` : undefined)}
      {row('Perda', stats.lossPct !== undefined ? `${stats.lossPct}%` : undefined)}
      {row('Jitter', stats.jitterMs !== undefined ? `${stats.jitterMs} ms` : undefined)}
      {row('Quadros descartados', stats.dropped)}
    </div>
  )
}
