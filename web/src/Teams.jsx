import { useEffect, useState } from 'react'
import { api } from './live.js'

// Team list: fix a typo'd sign-up, or get a team back in after a forgotten
// password. Re-fetches on every push, so new sign-ups appear as they happen.
export function Teams({ state, token, onError }) {
  const [teams, setTeams] = useState([])
  const [open, setOpen] = useState(false)
  // Shown until the next reset, so the host can read it out more than once.
  const [temp, setTemp] = useState(null)

  useEffect(() => {
    if (!open) return
    let live = true
    api('/api/admin/teams', { token })
      .then((r) => live && setTeams(r))
      .catch((e) => live && onError(e.message))
    return () => { live = false }
  }, [token, state, open, onError])

  const resetPassword = async (t) => {
    if (!window.confirm(`Give ${t.team_name} a new password? Their phones will be signed out.`)) return
    try {
      const r = await api(`/api/admin/teams/${t.id}/reset-password`, { method: 'POST', token })
      setTemp({ team: t.team_name, password: r.password })
    } catch (e) { onError(e.message) }
  }

  const remove = async (t) => {
    if (!window.confirm(`Remove ${t.team_name} and their ${t.score} point(s)? This cannot be undone.`)) return
    try {
      await api(`/api/admin/teams/${t.id}`, { method: 'DELETE', token })
    } catch (e) { onError(e.message) }
  }

  return (
    <div className="bank">
      <h3>
        Teams
        {state.scores.length > 0 && <span className="pill">{state.scores.length}</span>}
      </h3>
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? '▾ Hide teams' : '▸ Manage teams'}
      </button>

      {temp && (
        <p className="ok">New password for <strong>{temp.team}</strong>: <strong>{temp.password}</strong></p>
      )}

      {open && (
        !teams.length ? <p className="muted">No teams yet.</p> : (
          <ul className="subs">
            {teams.map((t) => (
              <li key={t.id}>
                <div><strong>{t.team_name}</strong> <span className="pill">{t.score} pts</span></div>
                <div className="row">
                  <button onClick={() => resetPassword(t)}>New password</button>
                  <button onClick={() => remove(t)}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}
