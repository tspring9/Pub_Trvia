import { useEffect, useRef, useState } from 'react'

// Counts down between pushes. Each push resets it from the server's seconds_left,
// so phones with wrong clocks still agree.
export function useCountdown(state) {
  const until = useRef(null)
  const [left, setLeft] = useState(state.seconds_left)

  useEffect(() => {
    until.current = state.seconds_left === null ? null : Date.now() + state.seconds_left * 1000
    setLeft(state.seconds_left)
    if (until.current === null) return

    const tick = () => setLeft(Math.max(0, Math.ceil((until.current - Date.now()) / 1000)))
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [state])

  return left
}

export function Timer({ state, className = '' }) {
  const left = useCountdown(state)
  if (left === null) return null
  const minutes = Math.floor(left / 60)
  const seconds = String(left % 60).padStart(2, '0')
  return (
    <p className={`timer ${left <= 30 ? 'urgent' : ''} ${className}`}>⏱ {minutes}:{seconds}</p>
  )
}
