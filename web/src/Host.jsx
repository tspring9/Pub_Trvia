import { useEffect, useRef, useState } from 'react'
import { api } from './live.js'
import { Bank } from './Bank.jsx'
import { Teams } from './Teams.jsx'
import { JoinQr, joinUrl } from './Qr.jsx'
import { Timer } from './Timer.jsx'

// Treats "The Beatles" and "beatles!" as the same answer.
const normalize = (text) => text
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^(the|a|an) /, '')

// An official answer can list alternatives: "Mercurio / Mercury".
const matches = (answer, official) =>
  official.split('/').some((option) => normalize(option) === normalize(answer) && normalize(answer) !== '')

// Same answers together, with those matching the official answer first.
function groupAnswers(subs, official) {
  const groups = new Map()
  for (const s of subs) {
    const key = normalize(s.submitted_answer)
    if (!groups.has(key)) groups.set(key, { key, text: s.submitted_answer, subs: [], exact: matches(s.submitted_answer, official) })
    groups.get(key).subs.push(s)
  }
  return [...groups.values()].sort((a, b) => b.exact - a.exact || b.subs.length - a.subs.length)
}

export function Host({ state, token, onSignedOut }) {
  const [subs, setSubs] = useState([])
  const [full, setFull] = useState(null)
  const [q, setQ] = useState('')
  const [a, setA] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [moving, setMoving] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [limit, setLimit] = useState(state.final_max_wager)
  const [minutes, setMinutes] = useState(state.timer_seconds / 60)
  useEffect(() => { setLimit(state.final_max_wager) }, [state.final_max_wager])
  useEffect(() => { setMinutes(state.timer_seconds / 60) }, [state.timer_seconds])
  // Last values the server gave us, so pushes do not clobber in-progress typing.
  const serverQA = useRef({ question_text: null, answer_text: null, note_text: null })

  const fail = (e) => {
    if (e.status === 403) onSignedOut()   // the host's session ran out
    else setErr(e.message)
  }

  // Re-fetch on every push. The push already fires on each new submission, so
  // this stays current without polling.
  useEffect(() => {
    let live = true

    api('/api/admin/submissions', { token })
      .then((r) => live && setSubs(r))
      .catch((e) => live && fail(e))

    // Full state, including the answer teams cannot see yet.
    api('/api/admin/state', { token })
      .then((gs) => {
        if (!live) return
        setFull(gs)
        // Only overwrite the boxes when the server's value actually changed —
        // e.g. a bank question was loaded — never on an unrelated push.
        const fields = [['question_text', setQ], ['answer_text', setA], ['note_text', setNote]]
        for (const [field, set] of fields) {
          if (gs[field] !== serverQA.current[field]) {
            serverQA.current[field] = gs[field]
            set(gs[field])
          }
        }
      })
      .catch((e) => live && fail(e))

    return () => { live = false }
  }, [token, state])

  const post = (path, body) => api(path, { method: 'POST', token, body }).catch(fail)
  const patch = (body) => post('/api/admin/state', body)
  const grade = (id, body) => post('/api/admin/grade', { id, ...body })
  const gradeGroup = (group, correct) =>
    post('/api/admin/grade-group', { ids: group.subs.map((s) => s.id), correct })

  const saveQA = () => {
    const body = { question_text: q, answer_text: a, note_text: note }
    if (q !== serverQA.current.question_text && subs.length) {
      body.reset_answers = window.confirm(
        `${subs.length} team(s) already answered this question.\n\n` +
        'OK clears their answers (a different question).\nCancel keeps them (just fixing a typo).',
      )
    }
    serverQA.current = { question_text: q, answer_text: a, note_text: note }
    patch(body)
  }

  const ungraded = subs.filter((s) => s.is_correct === null).length
  const special = state.kind === 'final' || state.kind === 'tiebreaker'
  const tied = full?.tied_teams ?? []

  const describe = (label, inBank) => inBank
    ? `Loaded ${label}. Open it when you are ready.`
    : `${label} is not in the bank, so type it in or load a backup.`

  const move = async (direction) => {
    if (direction === 1 && ungraded > 0 &&
        !window.confirm(`${ungraded} answer(s) still ungraded. Move on anyway? Back returns to them.`)) return
    setMoving(true); setErr(''); setInfo('')
    try {
      const r = await api('/api/admin/move', { method: 'POST', token, body: { direction } })
      setInfo(describe(r.label, r.in_bank))
    } catch (e) { fail(e) } finally { setMoving(false) }
  }

  const newGame = async (removeTeams) => {
    const warning = removeTeams
      ? 'Start a new game and remove every team? All scores and team sign-ups are erased.'
      : 'Start a new game? All scores and answers are erased, and teams stay signed up.'
    if (!window.confirm(warning)) return
    setErr(''); setInfo('')
    try {
      const r = await api('/api/admin/new-game', { method: 'POST', token, body: { remove_teams: removeTeams } })
      setInfo(`New game started. ${describe(r.label, r.in_bank)}`)
    } catch (e) { fail(e) }
  }

  const showWinners = () => {
    const undecided = tied.length > 0 && !full?.tiebreak_winner
    if (undecided && !window.confirm('First place is still tied. Show joint winners anyway?')) return
    post('/api/admin/winners', { show: true })
  }

  const publish = async () => {
    const r = await post('/api/admin/publish-scores')
    if (r) setInfo(`Scoreboard updated: ${r.label}.`)
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
        {state.show_winners && <span className="pill open">WINNERS SHOWING</span>}
      </div>

      <div className="row">
        <a className="linkbtn" href={`${import.meta.env.BASE_URL}display`} target="_blank" rel="noreferrer">
          🖥 Open room display
        </a>
        <button className="link" onClick={() => setShowQr(!showQr)}>
          {showQr ? '▾ Hide join code' : '▸ Show join code'}
        </button>
      </div>
      {showQr && (
        <div className="joinbox">
          <JoinQr size={200} />
          <p className="muted">{joinUrl()}</p>
        </div>
      )}

      <textarea
        rows={3} placeholder="Question text (what teams see)"
        value={q} onChange={(e) => setQ(e.target.value)}
      />
      <input
        placeholder={state.kind === 'halftime' ? 'Right order, separated by semicolons' : 'Official answer'}
        value={a} onChange={(e) => setA(e.target.value)}
      />
      <input
        placeholder="Fun fact (the room sees this after the reveal)"
        value={note} onChange={(e) => setNote(e.target.value)}
      />
      {state.kind === 'halftime' && !state.parts && (
        <p className="err">Save the right order, separated by semicolons, before opening halftime.</p>
      )}
      <button className="ghost" onClick={saveQA}>Save question</button>

      <Timer state={state} />
      {state.seconds_left !== null && (
        <button className="ghost" onClick={() => post('/api/admin/extend', { seconds: 30 })}>+30 seconds</button>
      )}

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
          disabled={moving || state.kind === 'tiebreaker' || (state.kind === 'final' && !tied.length)}
          onClick={() => move(1)}
        >
          {state.kind === 'final' && tied.length ? '⚔️ Tiebreaker' : '➡️ Next'}
        </button>
      </div>
      <button className="ghost" disabled={moving || state.step <= 1} onClick={() => move(-1)}>
        ⬅️ Back a question
      </button>

      {state.stage_end && (
        <button className="ghost" onClick={publish}>📊 Update the scoreboard now</button>
      )}

      {special && (
        <>
          {tied.length > 0 && !full?.tiebreak_winner && (
            <p className="err">First place is tied: {tied.map((t) => t.team_name).join(', ')}.</p>
          )}
          {state.show_winners ? (
            <button className="ghost" onClick={() => post('/api/admin/winners', { show: false })}>
              Hide winner screen to make changes
            </button>
          ) : (
            <button className="big" onClick={showWinners}>🏆 Show winners</button>
          )}
        </>
      )}

      <button className="ghost" onClick={() => patch({ allow_new_teams: !state.allow_new_teams })}>
        {state.allow_new_teams ? 'Close sign-ups' : 'Reopen sign-ups'}
      </button>

      <form
        className="row"
        onSubmit={(e) => { e.preventDefault(); patch({ timer_seconds: Math.round(Number(minutes) * 60) }) }}
      >
        <label className="muted" htmlFor="timer-minutes">Timer in minutes (0 turns it off)</label>
        <input
          id="timer-minutes" type="number" min="0" max="60" step="0.5" value={minutes}
          style={{ width: 90, margin: 0 }}
          onChange={(e) => setMinutes(e.target.value)}
        />
        <button type="submit" disabled={minutes === '' || Math.round(Number(minutes) * 60) === state.timer_seconds}>
          Save
        </button>
      </form>

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
      {note && <p className="muted">💡 {note}</p>}
      {!subs.length ? <p className="muted">No submissions for this question yet.</p> : (
        <ul className="subs">
          {state.kind === 'halftime'
            ? subs.map((s) => <HalftimeRow key={s.id} sub={s} official={a} grade={grade} />)
            : state.kind === 'tiebreaker'
              ? subs.map((s) => (
                <TiebreakRow
                  key={s.id} sub={s} winnerId={full?.tiebreak_winner}
                  pick={(teamId) => post('/api/admin/tiebreak-winner', { team_id: teamId })}
                />
              ))
              : groupAnswers(subs, a).map((g) => (
                <AnswerGroup key={g.key} group={g} kind={state.kind} gradeGroup={gradeGroup} />
              ))}
        </ul>
      )}

      <div className="bank">
        <h3>Live scores <span className="pill">only you see these</span></h3>
        <ol className="scores">
          {(full?.live_scores ?? []).map((t) => (
            <li key={t.id}><span>{t.team_name}</span><strong>{t.score}</strong></li>
          ))}
        </ol>
      </div>

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

// Every team that gave this answer, graded with one tap.
function AnswerGroup({ group, kind, gradeGroup }) {
  const graded = group.subs.every((s) => s.is_correct !== null)
  const word = kind === 'final' ? 'bet' : 'wager'

  return (
    <li className={graded ? 'done' : ''}>
      <div>
        <p className="ans">
          {group.text} {group.exact && <span className="pill open">matches</span>}
        </p>
        {group.subs.map((s) => (
          <p className="muted team-line" key={s.id}>
            {s.team_name} · {word} {s.wager_points}
            {s.is_correct !== null && ` · ${s.is_correct ? '✅' : '❌'} ${s.awarded_points > 0 ? '+' : ''}${s.awarded_points}`}
          </p>
        ))}
      </div>
      <div className="row">
        <button onClick={() => gradeGroup(group, true)}>✅</button>
        <button onClick={() => gradeGroup(group, false)}>❌</button>
      </div>
    </li>
  )
}

function TiebreakRow({ sub, winnerId, pick }) {
  const isWinner = winnerId === sub.team_id
  return (
    <li>
      <div>
        <strong>{sub.team_name}</strong>
        <p className="ans">{sub.submitted_answer}</p>
      </div>
      <div className="row">
        <button className={isWinner ? 'wager on' : ''} onClick={() => pick(isWinner ? null : sub.team_id)}>
          🏆 {isWinner ? 'Winner' : 'Pick'}
        </button>
      </div>
    </li>
  )
}

// The team's list next to the right one, spot by spot, then tap how many match.
function HalftimeRow({ sub, official, grade }) {
  const theirs = sub.submitted_answer.split('\n')
  const right = official.split(';').map((p) => p.trim())
  const counts = Array.from({ length: theirs.length + 1 }, (_, n) => n)
  const isExact = (i) => right[i] !== undefined && matches(theirs[i], right[i])
  const suggested = theirs.filter((_, i) => isExact(i)).length

  return (
    <li className={`halftime ${sub.is_correct === null ? '' : 'done'}`}>
      <strong>{sub.team_name}</strong>
      <table>
        <tbody>
          {theirs.map((answer, i) => (
            <tr key={i} className={isExact(i) ? 'spot-match' : ''}>
              <td className="muted">{i + 1}.</td>
              <td>{answer || <span className="muted">(blank)</span>}</td>
              <td className="muted">{right[i] ?? ''}</td>
              <td>{isExact(i) ? '✓' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sub.is_correct !== null && (
        <p className="muted">{sub.correct_parts} in the right spot · +{sub.awarded_points} points</p>
      )}
      <p className="muted">How many are in the right spot? Exact matches: {suggested}</p>
      <div className="row">
        {counts.map((n) => (
          <button
            key={n}
            className={sub.correct_parts === n ? 'wager on' : n === suggested ? 'suggest' : ''}
            onClick={() => grade(sub.id, { correct_parts: n })}
          >{n}</button>
        ))}
      </div>
    </li>
  )
}
