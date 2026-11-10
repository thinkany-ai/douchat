import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The web app: the desktop renderer on top of src/web/webApi.ts. Built, it is
 * served by douchat-tanstack from /app and as app.douchat.ai, so /api is the
 * same origin and sign-in happens on douchat.ai.
 *
 * `npm run dev:web` serves it with live reload at http://app.localhost:5276
 * (the stand-in for app.douchat.ai): /api and /v1 go to the local service,
 * and sign-in goes to the local service's site, which allows this callback.
 * `make dev` also opens both to phones on the LAN; see scripts/dev.mjs.
 */
const service = process.env.DOUCHAT_SERVICE_URL || 'http://localhost:3004'
/** Where people sign in; `make dev` sets the LAN address so phones can reach it too. */
const site = process.env.DOUCHAT_SITE_URL || service

export default defineConfig(({ command }) => ({
  root: resolve(__dirname, 'src/web'),
  // Pages live at the root on the app host; the built files sit under /app.
  base: command === 'build' ? '/app/' : '/',
  publicDir: resolve(__dirname, 'src/renderer/public'),
  // Its own optimizer cache: the desktop renderer's dev server uses node_modules/.vite
  // with another config, and sharing it rebuilds the deps under a running page,
  // which then loads two copies of React ("reading 'useId'" of null).
  cacheDir: resolve(__dirname, 'node_modules/.vite-web'),
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  define: command === 'build' ? {} : { 'import.meta.env.VITE_DOUCHAT_SITE': JSON.stringify(site) },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true
  },
  server: {
    // `make dev` listens on every interface so phones on the LAN can connect.
    host: process.env.DOUCHAT_WEB_HOST || 'localhost',
    port: Number(process.env.DOUCHAT_WEB_PORT || 5276),
    strictPort: true,
    allowedHosts: ['app.localhost', '.nip.io'],
    proxy: {
      '/api': { target: service, changeOrigin: true },
      '/v1': { target: service, changeOrigin: true }
    }
  }
}))
