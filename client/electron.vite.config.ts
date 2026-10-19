import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Todas as libs do renderer são empacotadas pelo Vite (ficam em devDependencies),
// então o instalador não carrega node_modules extras.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()], build: { minify: true } },
})
