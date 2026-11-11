// Limits on anything a stranger can reach, since the app is on the public internet.
export const MAX_TEAMS = 50
export const MAX_TEAM_NAME = 40
export const MAX_PASSWORD = 200
export const MAX_ANSWER = 300

export const HOST_LOGIN_ATTEMPTS = 5
export const TEAM_LOGIN_ATTEMPTS = 10
const WINDOW_MS = 15 * 60 * 1000

type Entry = { count: number; resetAt: number }
const failures = new Map<string, Entry>()

// Funnel connects over loopback and appends the real caller as the last entry,
// so anything earlier in the header could have been written by the caller.
export function clientIp(req: { headers: Record<string, unknown>; ip: string }): string {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
  return forwarded.split(',').pop()?.trim() || req.ip
}

// Minutes until this key may try again, or 0 if it can try now.
export function lockedForMinutes(key: string, max: number): number {
  const entry = failures.get(key)
  if (!entry || Date.now() >= entry.resetAt || entry.count < max) return 0
  return Math.ceil((entry.resetAt - Date.now()) / 60000)
}

export function recordFailure(key: string) {
  const now = Date.now()
  if (failures.size > 5000) {
    for (const [k, e] of failures) if (now >= e.resetAt) failures.delete(k)
  }
  const entry = failures.get(key)
  if (!entry || now >= entry.resetAt) failures.set(key, { count: 1, resetAt: now + WINDOW_MS })
  else entry.count++
}

export const clearFailures = (key: string) => { failures.delete(key) }
