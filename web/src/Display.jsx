import { useLiveState } from './live.js'
import { JoinQr, joinUrl } from './Qr.jsx'
import { Timer } from './Timer.jsx'
import { Winners } from './Winners.jsx'

// The screen for the room. Read-only and needs no login, and it only ever shows
// what teams are allowed to see.
export function Display() {
  const { state } = useLiveState()
  if (!state) return <main className="display"><p className="d-wait">Connecting…</p></main>

  return (
    <main className="display">
      {state.show_winners ? <Winners state={state} />
        : state.question_text ? <Question state={state} />
        : state.scoreboard_label ? <Standings state={state} />
        : <Lobby state={state} />}
    </main>
  )
}

function Lobby({ state }) {
  return (
    <div className="d-lobby">
      <div>
        <h1>🍻 Pub Trivia</h1>
        <p className="d-sub">Scan to join with your team</p>
        <p className="d-url">{joinUrl()}</p>
        <ul className="d-teams">
          {state.scores.map((s) => <li key={s.team_name}>{s.team_name}</li>)}
        </ul>
      </div>
      <JoinQr size={420} />
    </div>
  )
}

function Question({ state }) {
  return (
    <div className="d-question">
      <div className="d-top">
        <span className="d-label">{state.label}</span>
        <Timer state={state} />
      </div>
      <p className="d-text">{state.question_text}</p>

      {state.revealed && state.answer_text ? (
        <div className="d-answer">
          {state.kind === 'halftime' ? (
            <ol>{state.answer_text.split(';').map((a, i) => <li key={i}>{a.trim()}</li>)}</ol>
          ) : <p>{state.answer_text}</p>}
          {state.note_text && <p className="d-note">{state.note_text}</p>}
        </div>
      ) : (
        <p className="d-sub">
          {state.submissions_open
            ? `${state.answered} of ${state.kind === 'tiebreaker' ? state.tiebreak_teams.length : state.scores.length} answered`
            : 'Answers are locked'}
        </p>
      )}

      {state.kind === 'tiebreaker' && (
        <p className="d-sub">Between {state.tiebreak_teams.join(' & ')}</p>
      )}
    </div>
  )
}

function Standings({ state }) {
  return (
    <div className="d-lobby">
      <div className="d-standings">
        <h1>Standings</h1>
        <p className="d-sub">{state.scoreboard_label}</p>
        <ol className="scores">
          {state.scores.map((s) => (
            <li key={s.team_name}><span>{s.team_name}</span><strong>{s.score}</strong></li>
          ))}
        </ol>
        <p className="d-sub">Up next: {state.label}</p>
      </div>
      <JoinQr size={220} />
    </div>
  )
}
