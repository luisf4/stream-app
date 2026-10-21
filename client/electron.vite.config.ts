import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import pkg from './package.json'

// Todas as libs do renderer são empacotadas pelo Vite (ficam em devDependencies),
// então o instalador não carrega node_modules extras.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    build: { minify: true },
    // versão do app (o GitHub Actions troca a do package.json antes de buildar)
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    // o modelo do RNNoise (.wasm) é embutido no bundle com "?inline" (ver lib/noise.ts)
    assetsInclude: ['**/*.wasm'],
  },
})
