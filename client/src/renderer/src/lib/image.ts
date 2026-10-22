// Reduz imagens antes de enviar: lado maior até 2560 px e WebP. Um print de 4 MB vira ~300 KB
// sem diferença visível no chat. GIF (pode ser animado) e SVG vão como estão.
const MAX_SIDE = 2560
const QUALITY = 0.85
const MIN_SIZE = 150 * 1024
const OPTIMIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/avif'])

export async function optimizeImage(file: File): Promise<File> {
  if (!OPTIMIZABLE.has(file.type) || file.size < MIN_SIZE) return file
  try {
    // createImageBitmap já aplica a rotação do EXIF (foto de celular não fica deitada)
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY })
    if (blob.size >= file.size) return file
    const base = (file.name || 'imagem').replace(/\.[^.]+$/, '')
    return new File([blob], `${base}.webp`, { type: 'image/webp', lastModified: file.lastModified })
  } catch {
    return file // formato que o navegador não decodifica: envia o original
  }
}

const AVATAR_SIDE = 256

/** Foto de perfil: recorta o centro em quadrado, 256 px, WebP. GIF vai como está (pode ser animado). */
export async function avatarImage(file: File): Promise<File> {
  if (file.type === 'image/gif') return file
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const size = Math.min(AVATAR_SIDE, side)
  const canvas = new OffscreenCanvas(size, size)
  canvas
    .getContext('2d')!
    .drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
  return new File([blob], 'avatar.webp', { type: 'image/webp' })
}
