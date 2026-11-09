import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The PUBLIC url prefix, i.e. what the browser sees: '/trivia-dev' behind the
// Funnel, '/' locally. Deliberately NOT the server's BASE_PATH — Funnel strips
// the prefix before proxying, so the server sees '/' while the browser does not.
const base = process.env.PUBLIC_BASE ? `${process.env.PUBLIC_BASE}/` : '/'

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // `npm run dev` here proxies to the Fastify process on 8789, so the
    // frontend hot-reloads while talking to the real database.
    proxy: {
      '/api': 'http://127.0.0.1:8789',
      '/ws': { target: 'ws://127.0.0.1:8789', ws: true },
    },
  },
})
