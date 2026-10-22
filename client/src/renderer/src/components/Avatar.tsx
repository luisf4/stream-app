import { useState } from 'react'
import { colorFor } from '../lib/format'
import { useStore } from '../store'

export function Avatar({
  name,
  src,
  size = 32,
  speaking = false,
  online,
}: {
  name: string
  /** foto de perfil (/files/...) */
  src?: string | null
  size?: number
  speaking?: boolean
  /** mostra a bolinha de online/offline */
  online?: boolean
}) {
  const api = useStore((s) => s.api)
  const [failed, setFailed] = useState<string | null>(null)
  const url = src && api && failed !== src ? api.url(src) : null

  return (
    <div
      className={`avatar${speaking ? ' speaking' : ''}`}
      style={{ width: size, height: size, background: url ? undefined : colorFor(name), fontSize: size * 0.42 }}
    >
      {url ? <img src={url} alt="" draggable={false} onError={() => setFailed(src!)} /> : name.slice(0, 1).toUpperCase()}
      {online !== undefined && (
        <span className={`presence-dot${online ? ' online' : ''}`} aria-label={online ? 'Online' : 'Offline'} />
      )}
    </div>
  )
}
