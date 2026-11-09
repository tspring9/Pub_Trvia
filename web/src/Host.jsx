import { useEffect, useRef, useState } from 'react'
import { api } from './live.js'
import { Bank } from './Bank.jsx'
import { Teams } from './Teams.jsx'

export function Host({ state, token }) {
  const [subs, setSubs] = useState([])
  const [q, setQ] = useState('')
  const [a, setA] = useState('')
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [moving, setMoving] = useState(false)
  const [limit, setLimit] = useState(state.final_max_wager)
  useEffect(() => { setLimit(state.final_max_wager) }, [state.final_max_wager])
  // Last values the server gave us, so pushes do not clobber in-progress typing.
  const serverQA = useRef({ question_text: null, answer_text: null })

  // Re-fetch on every push. The push already fires on each new submission, so
  // this stays current without polling.
  useEffect(() => {
    let live = true

    api('/api/admin/submissions', { token })
      .then((r) => live && setSubs(r))
      .catch((e) => live && setErr(e.message))

    // Full state, including the answer teams cannot see yet.
    api('/api/admin/state', { token })
      .then((gs) => {
        if (!live) return
        // Only overwrite the boxes when the server's value actually changed —
        // e.g. a bank question was loaded — never on an unrelated push.
        if (gs.question_text !== serverQA.current.question_text) {
          serverQA.current.question_text = gs.question_text
          setQ(gs.question_text)
        }
        if (gs.answer_text !== serverQA.current.answer_text) {
          serverQA.current.answer_text = gs.answer_text
          setA(gs.answer_text)
        }
      })
      .catch((e) => live && setErr(e.message))

    return () => { live = false }
  }, [token, state])

  const patch = (body) =>
    api('/api/admin/state', { method: 'POST', token, body }).catch((e) => setErr(e.message))

  const grade = (id, body) =>
    api('/api/admin/grade', { method: 'POST', token, body: { id, ...body } })
      .catch((e) => setErr(e.message))

  const ungraded = subs.filter((s) => s.is_correct === null).length

  const describe = (label, inBank, note) => {
    if (!inBank) return `${label} is not in the bank, so type it in or load a backup.`
    return `Loaded ${label}${note ? ` — note: ${note}` : ''}. Open it when you are ready.`
  }

  const move = async (direction) => {
    if (direction === 1 && ungraded > 0 &&
        !window.confirm(`${ungraded} answer(s) still ungraded. Move on anyway? Back returns to them.`)) return
    setMoving(true); setErr(''); setInfo('')
    try {
      const r = await api('/api/admin/move', { method: 'POST', token, body: { direction } })
      setInfo(describe(r.label, r.in_bank, r.note))
    } catch (e) { setErr(e.message) } finally { setMoving(false) }
  }

  const newGame = async (removeTeams) => {
    const warning = removeTeams
      ? 'Start a new game and remove every team? All scores and team sign-ups are erased.'
      : 'Start a new game? All scores and answers are erased, and teams stay signed up.'
    if (!window.confirm(warning)) return
    setErr(''); setInfo('')
    try {
      const r = await api('/api/admin/new-game', { method: 'POST', token, body: { remove_teams: removeTeams } })
      setInfo(`New game started. ${describe(r.label, r.in_bank, r.note)}`)
    } catch (e) { setErr(e.message) }
  }

  return (
    <section className="card host">
      <h2>Host controls</h2>
      {err && <p className="err">{err}</p>}
      {info && <p className="ok">{info}</p>}

      <div className="row">
        <span className="pill">{state.label}</span>
        <span className="pill">Half {state.half}</span>
        <span className={state.submissions_open ? 'pill open' : 'pill'}>
          {state.submissions_open ? 'OPEN' : 'CLOSED'}
        </span>
        {state.revealed && <span className="pill open">REVEALED</span>}
      </div>

      <textarea
        rows={3} placeholder="Question text (what teams see)"
        value={q} onChange={(e) => setQ(e.target.value)}
      />
      <input
        placeholder={state.kind === 'halftime' ? 'Right order, separated by semicolons' : 'Official answer'}
        value={a} onChange={(e) => setA(e.target.value)}
      />
      {state.kind === 'halftime' && !state.parts && (
        <p className="err">Save the right order, separated by semicolons, before opening halftime.</p>
      )}
      <button
        className="ghost"
        onClick={() => {
          serverQA.current = { question_text: q, answer_text: a }
          patch({ question_text: q, answer_text: a })
        }}
      >
        Save Q &amp; A
      </button>

      <div className="grid">
        <button
          className="big"
          disabled={state.kind === 'halftime' && !state.parts}
          onClick={() => patch({ submissions_open: true, revealed: false })}
        >
          ✅ Open
        </button>
        <button className="big" onClick={() => patch({ submissions_open: false })}>
          ⛔ Close
        </button>
        <button className="big" onClick={() => patch({ revealed: true })}>
          👀 Reveal
        </button>
        <button
          className="big"
          disabled={moving || state.step >= state.total_steps}
          onClick={() => move(1)}
        >
          ➡️ Next
        </button>
      </div>
      <button className="ghost" disabled={moving || state.step <= 1} onClick={() => move(-1)}>
        ⬅️ Back a question
      </button>

      <button className="ghost" onClick={() => patch({ allow_new_teams: !state.allow_new_teams })}>
        {state.allow_new_teams ? 'Close sign-ups' : 'Reopen sign-ups'}
      </button>

      <form
        className="row"
        onSubmit={(e) => { e.preventDefault(); patch({ final_max_wager: Number(limit) }) }}
      >
        <label className="muted" htmlFor="final-limit">Most a team can bet on the final</label>
        <input
          id="final-limit" type="number" min="0" step="1" value={limit}
          style={{ width: 90, margin: 0 }}
          onChange={(e) => setLimit(e.target.value)}
        />
        <button type="submit" disabled={limit === '' || Number(limit) === state.final_max_wager}>
          Save
        </button>
      </form>

      <Bank token={token} position={state.position} />

      <h3>Grading {ungraded > 0 && <span className="badge">{ungraded} to go</span>}</h3>
      {a && state.kind !== 'halftime' && <p className="muted">Official answer: <strong>{a}</strong></p>}
      {!subs.length ? <p className="muted">No submissions for this question yet.</p> : (
        <ul className="subs">
          {subs.map((s) => (
            state.kind === 'halftime'
              ? <HalftimeRow key={s.id} sub={s} official={a} grade={grade} />
              : (
                <li key={s.id} className={s.is_correct === null ? '' : 'done'}>
                  <div>
                    <strong>{s.team_name}</strong>{' '}
                    <span className="pill">{state.kind === 'final' ? 'bet' : 'wager'} {s.wager_points}</span>
                    <p className="ans">{s.submitted_answer}</p>
                    {s.is_correct !== null && (
                      <p className="muted">
                        {s.is_correct ? '✅ correct' : '❌ wrong'} · {s.awarded_points > 0 ? '+' : ''}{s.awarded_points} points
                      </p>
                    )}
                  </div>
                  <div className="row">
                    <button onClick={() => grade(s.id, { correct: true })}>✅</button>
                    <button onClick={() => grade(s.id, { correct: false })}>❌</button>
                  </div>
                </li>
              )
          ))}
        </ul>
      )}

      <Teams state={state} token={token} onError={setErr} />

      <div className="bank">
        <h3>New game</h3>
        <p className="muted">Clears scores and answers and goes back to round 1. The question bank stays.</p>
        <button className="ghost" onClick={() => newGame(false)}>Start new game, keep teams</button>
        <button className="ghost" onClick={() => newGame(true)}>Start new game, remove teams</button>
      </div>
    </section>
  )
}

// The team's list next to the right one, spot by spot, then tap how many match.
function HalftimeRow({ sub, official, grade }) {
  const theirs = sub.submitted_answer.split('\n')
  const right = official.split(';').map((p) => p.trim())
  const counts = Array.from({ length: theirs.length + 1 }, (_, n) => n)

  return (
    <li className={`halftime ${sub.is_correct === null ? '' : 'done'}`}>
      <strong>{sub.team_name}</strong>
      <table>
        <tbody>
          {theirs.map((answer, i) => (
            <tr key={i}>
              <td className="muted">{i + 1}.</td>
              <td>{answer || <span className="muted">(blank)</span>}</td>
              <td className="muted">{right[i] ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sub.is_correct !== null && (
        <p className="muted">{sub.correct_parts} in the right spot · +{sub.awarded_points} points</p>
      )}
      <p className="muted">How many are in the right spot?</p>
      <div className="row">
        {counts.map((n) => (
          <button
            key={n}
            className={sub.correct_parts === n ? 'wager on' : ''}
            onClick={() => grade(sub.id, { correct_parts: n })}
          >{n}</button>
        ))}
      </div>
    </li>
  )
}
