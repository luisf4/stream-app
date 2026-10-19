import { colorFor } from '../lib/format'

export function Avatar({
  name,
  size = 32,
  speaking = false,
}: {
  name: string
  size?: number
  speaking?: boolean
}) {
  return (
    <div
      className={`avatar${speaking ? ' speaking' : ''}`}
      style={{ width: size, height: size, background: colorFor(name), fontSize: size * 0.42 }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  )
}
