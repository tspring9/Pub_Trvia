import { useState } from 'react'
import { api, useLiveState, store } from './live.js'
import { Host } from './Host.jsx'
import { TeamQuestion } from './Team.jsx'

export default function App() {
  const { state, connected } = useLiveState()
  const [auth, setAuth] = useState(store.get())

  const signOut = () => { store.clear(); setAuth(null) }

  return (
    <div className="app">
      <header>
        <h1>🍻 Pub Trivia</h1>
        <span className={connected ? 'dot live' : 'dot'} title={connected ? 'Live' : 'Reconnecting…'} />
        {auth && <button className="link" onClick={signOut}>Sign out</button>}
      </header>

      {!state ? (
        <p className="muted">Connecting…</p>
      ) : !auth ? (
        <Login onAuth={(a) => { store.set(a); setAuth(a) }} allowNew={state.allow_new_teams} />
      ) : auth.is_admin ? (
        <Host state={state} token={auth.token} />
      ) : (
        <section className="card">
          <p className="muted">Team — <strong>{auth.team_name}</strong></p>
          {/* Keyed by position: a new question starts with a clean form. */}
          <TeamQuestion
            key={`${state.round}-${state.question}`}
            state={state} auth={auth} onSignedOut={signOut}
          />
        </section>
      )}

      {state && <Scoreboard scores={state.scores} state={state} />}
    </div>
  )
}

function Login({ onAuth, allowNew }) {
  const [mode, setMode] = useState(null)
  const [name, setName] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      if (mode === 'team') {
        const r = await api('/api/team/login', { method: 'POST', body: { team_name: name, password: pw } })
        onAuth({ token: r.token, team_name: r.team_name, is_admin: false })
      } else {
        const r = await api('/api/admin/login', { method: 'POST', body: { password: pw } })
        onAuth({ token: r.token, is_admin: true })
      }
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  if (!mode) return (
    <section className="card">
      <h2>Welcome</h2>
      <p className="muted">
        {allowNew
          ? 'New teams can sign up with any name and password.'
          : 'The host has closed new sign-ups — use your existing team name.'}
      </p>
      <button className="big" onClick={() => setMode('team')}>👥 I'm a team</button>
      <button className="ghost" onClick={() => setMode('admin')}>🛠️ I'm the host</button>
    </section>
  )

  return (
    <form className="card" onSubmit={submit}>
      <h2>{mode === 'team' ? 'Team sign in' : 'Host sign in'}</h2>
      {mode === 'team' && (
        <input
          placeholder="Team name" value={name} autoCapitalize="words"
          onChange={(e) => setName(e.target.value)} required
        />
      )}
      <input
        type="password" placeholder="Password" value={pw}
        onChange={(e) => setPw(e.target.value)} required
      />
      {err && <p className="err">{err}</p>}
      <button className="big" disabled={busy}>{busy ? 'Signing in…' : 'Enter'}</button>
      <button type="button" className="ghost" onClick={() => { setMode(null); setErr('') }}>← Back</button>
    </form>
  )
}

function Scoreboard({ scores, state }) {
  return (
    <section className="card">
      <h2>Scoreboard</h2>
      <p className="muted">
        {state.label} · Half {state.half}
        {' · '}{state.submissions_open ? 'OPEN' : 'CLOSED'}
      </p>
      {!scores.length ? <p className="muted">No teams yet.</p> : (
        <ol className="scores">
          {scores.map((s) => (
            <li key={s.team_name}><span>{s.team_name}</span><strong>{s.score}</strong></li>
          ))}
        </ol>
      )}
    </section>
  )
}
