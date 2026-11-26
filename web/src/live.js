import { useEffect, useRef, useState } from 'react'

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

export const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`)
    err.status = res.status
    err.data = data
    // CSV import returns a per-row list; keep it rather than collapsing to one line.
    if (Array.isArray(data.errors)) err.rows = data.errors
    throw err
  }
  return data
}

// The whole point of the rewrite: state arrives pushed, not polled.
//
// A phone that sleeps kills the socket silently, so we reconnect on wake
// (visibilitychange) and on any close, with backoff. Streamlit could not do
// this because its session lived server-side and vanished with the socket.
//
// The socket can also hang without ever failing: Tailscale Funnel sometimes
// leaves a browser's connection stuck after the app restarts. So a connection
// that has not opened within 8 seconds is dropped and retried, the server pings
// every 25 seconds so a silent socket is noticed, and while there is no working
// socket the page fetches the state every 3 seconds instead.
const OPEN_TIMEOUT_MS = 8000
const SILENT_MS = 60000
const POLL_MS = 3000

export function useLiveState() {
  const [state, setState] = useState(null)
  const [connected, setConnected] = useState(false)
  const ws = useRef(null)
  const retry = useRef(0)
  const timer = useRef(null)
  const lastMessage = useRef(0)

  useEffect(() => {
    let dead = false

    const socketHealthy = () =>
      ws.current?.readyState === WebSocket.OPEN && Date.now() - lastMessage.current < SILENT_MS

    const connect = () => {
      if (dead) return
      const current = ws.current
      if (current && (current.readyState === WebSocket.CONNECTING || socketHealthy())) return
      if (current && current.readyState === WebSocket.OPEN) current.close()   // open but silent

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const sock = new WebSocket(`${proto}//${location.host}${BASE}/ws`)
      ws.current = sock
      const openTimer = setTimeout(() => { if (sock.readyState === WebSocket.CONNECTING) sock.close() }, OPEN_TIMEOUT_MS)

      sock.onopen = () => { clearTimeout(openTimer); lastMessage.current = Date.now(); setConnected(true); retry.current = 0 }
      sock.onmessage = (e) => {
        lastMessage.current = Date.now()
        const msg = JSON.parse(e.data)
        if (msg.type === 'state') setState(msg.state)
      }
      sock.onclose = () => {
        clearTimeout(openTimer)
        if (ws.current !== sock) return   // an older socket; a newer one is in charge
        setConnected(false)
        if (dead) return
        // 0.5s, 1s, 2s, 4s ... capped at 5s
        const wait = Math.min(500 * 2 ** retry.current++, 5000)
        timer.current = setTimeout(connect, wait)
      }
      sock.onerror = () => sock.close()
    }

    // The fallback: while the socket is not working, fetch the state directly,
    // and nudge the socket to try again.
    const poll = setInterval(async () => {
      if (dead || socketHealthy()) return
      try {
        const res = await fetch(`${BASE}/api/state`, { cache: 'no-store' })
        if (res.ok && !dead && !socketHealthy()) { setState(await res.json()); setConnected(true) }
      } catch { /* offline: keep trying */ }
      connect()
    }, POLL_MS)

    const onWake = () => { if (document.visibilityState === 'visible') connect() }

    connect()
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', connect)

    return () => {
      dead = true
      clearTimeout(timer.current)
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', connect)
      ws.current?.close()
    }
  }, [])

  return { state, connected }
}

// Token lives here, not in server memory, which is why locking the phone no
// longer logs a team out.
export const store = {
  get: () => {
    try { return JSON.parse(localStorage.getItem('pubtrivia') ?? 'null') }
    catch { return null }
  },
  set: (v) => localStorage.setItem('pubtrivia', JSON.stringify(v)),
  clear: () => localStorage.removeItem('pubtrivia'),
}
