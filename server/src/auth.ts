import { randomBytes, randomInt, scrypt as _scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { q } from './db.ts'

const scrypt = promisify(_scrypt) as (
  pw: string, salt: Buffer, len: number,
) => Promise<Buffer>

// app.py used bare sha256(password) with no salt. Anything reachable from the
// public internet needs a salt and a slow KDF, so: scrypt, stdlib, no deps.
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(pw, salt, 64)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(keyHex, 'hex')
  return key.length === expected.length && timingSafeEqual(key, expected)
}

// The host reads this out across a bar, so no 0/O or 1/l/I.
export function generateTempPassword(length = 8): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('')
}

export type Session = { token: string; team_id: number | null; is_admin: boolean }

export async function createSession(
  subject: { teamId: number } | { admin: true },
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const teamId = 'teamId' in subject ? subject.teamId : null
  await q(
    'INSERT INTO sessions (token, team_id, is_admin) VALUES ($1, $2, $3)',
    [token, teamId, teamId === null],
  )
  return token
}

// Bearer token out of localStorage. Survives the screen locking, which
// st.session_state did not.
export async function sessionFrom(authHeader?: string): Promise<Session | null> {
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const rows = await q<Session>(
    `UPDATE sessions SET last_seen = now() WHERE token = $1
     RETURNING token, team_id, is_admin`,
    [token],
  )
  return rows[0] ?? null
}
