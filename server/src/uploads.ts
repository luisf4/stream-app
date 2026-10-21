import { unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { config, uploadDir } from './config.js'
import { expireImages, imageCutoff } from './db.js'

const HOUR = 60 * 60 * 1000

/** Apaga arquivos de uploads/ (nomes vindos do banco). */
export function removeUploads(files: string[]) {
  for (const file of files) void unlink(join(uploadDir, basename(file))).catch(() => {})
}

/** Imagens do chat vivem IMAGE_TTL_DAYS; confere ao iniciar e a cada hora. */
export function startImageExpiry(log: (msg: string) => void) {
  if (!(config.imageTtlDays > 0)) return
  const run = () => {
    const files = expireImages(imageCutoff())
    if (files.length) log(`${files.length} imagem(ns) com mais de ${config.imageTtlDays} dias apagada(s)`)
    removeUploads(files)
  }
  run()
  setInterval(run, HOUR).unref()
}
