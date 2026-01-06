import sqlite3
import time
import hashlib
from datetime import datetime

import streamlit as st

DB_PATH = "trivia.db"

# -----------------------------
# Config
# -----------------------------
DEFAULT_ADMIN_PASSWORD = "changeme"  # replace or move to st.secrets["ADMIN_PASSWORD"]
AUTO_REFRESH_SECONDS = 3            # scoreboard refresh cadence

# -----------------------------
# DB helpers
# -----------------------------
def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_name TEXT NOT NULL UNIQUE,
        pass_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_round INTEGER NOT NULL DEFAULT 1,
        current_question INTEGER NOT NULL DEFAULT 1,
        half INTEGER NOT NULL DEFAULT 1,              -- 1 or 2
        question_text TEXT NOT NULL DEFAULT '',
        answer_text TEXT NOT NULL DEFAULT '',
        submissions_open INTEGER NOT NULL DEFAULT 0,  -- 0/1
        revealed INTEGER NOT NULL DEFAULT 0,          -- 0/1
        updated_at TEXT NOT NULL DEFAULT ''
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id INTEGER NOT NULL,
        round_num INTEGER NOT NULL,
        question_num INTEGER NOT NULL,
        half INTEGER NOT NULL,
        submitted_answer TEXT NOT NULL,
        wager_points INTEGER NOT NULL,
        submitted_at TEXT NOT NULL,
        is_correct INTEGER,                -- NULL until graded; 0/1 after graded
        awarded_points INTEGER NOT NULL DEFAULT 0,
        graded_at TEXT,
        UNIQUE(team_id, round_num, question_num),
        FOREIGN KEY(team_id) REFERENCES teams(id)
    )
    """)

    # Ensure game_state row exists
    cur.execute("SELECT id FROM game_state WHERE id = 1")
    row = cur.fetchone()
    if not row:
        cur.execute("""
        INSERT INTO game_state (id, current_round, current_question, half, question_text, answer_text,
                                submissions_open, revealed, updated_at)
        VALUES (1, 1, 1, 1, '', '', 0, 0, ?)
        """, (datetime.utcnow().isoformat(),))

    conn.commit()
    conn.close()

def sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def get_game_state(conn):
    cur = conn.cursor()
    cur.execute("SELECT * FROM game_state WHERE id=1")
    return cur.fetchone()

def set_game_state(conn, **kwargs):
    allowed = {
        "current_round", "current_question", "half",
        "question_text", "answer_text",
        "submissions_open", "revealed", "updated_at"
    }
    keys = [k for k in kwargs.keys() if k in allowed]
    if not keys:
        return
    parts = ", ".join([f"{k} = ?" for k in keys] + ["updated_at = ?"])
    values = [kwargs[k] for k in keys] + [datetime.utcnow().isoformat()]
    cur = conn.cursor()
    cur.execute(f"UPDATE game_state SET {parts} WHERE id=1", values)
    conn.commit()

def get_or_create_team(conn, team_name: str, password: str):
    team_name = team_name.strip()
    if not team_name:
        return None, "Team name cannot be empty."
    if len(password) < 4:
        return None, "Password must be at least 4 characters."

    cur = conn.cursor()
    cur.execute("SELECT * FROM teams WHERE team_name = ?", (team_name,))
    existing = cur.fetchone()
    if existing:
        # validate password
        if existing["pass_hash"] != sha256(password):
            return None, "Incorrect password for that team name."
        return dict(existing), None

    # create
    try:
        cur.execute(
            "INSERT INTO teams (team_name, pass_hash, created_at) VALUES (?, ?, ?)",
            (team_name, sha256(password), datetime.utcnow().isoformat()),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        return None, "That team name was just taken. Try again."
    cur.execute("SELECT * FROM teams WHERE team_name = ?", (team_name,))
    created = cur.fetchone()
    return dict(created), None

def compute_scores(conn):
    cur = conn.cursor()
    cur.execute("""
    SELECT t.id, t.team_name,
           COALESCE(SUM(s.awarded_points), 0) AS score
    FROM teams t
    LEFT JOIN submissions s ON s.team_id = t.id
    GROUP BY t.id, t.team_name
    ORDER BY score DESC, t.team_name ASC
    """)
    return [dict(r) for r in cur.fetchall()]

def allowed_wagers(half: int):
    return [1, 3, 5] if half == 1 else [2, 4, 6]

def upsert_submission(conn, team_id: int, gs, submitted_answer: str, wager_points: int):
    cur = conn.cursor()
    now = datetime.utcnow().isoformat()

    # If already exists, update only if not graded yet
    cur.execute("""
        SELECT * FROM submissions
        WHERE team_id = ? AND round_num = ? AND question_num = ?
    """, (team_id, gs["current_round"], gs["current_question"]))
    existing = cur.fetchone()

    if existing and existing["is_correct"] is not None:
        return False, "This question has already been graded; you can’t change your answer now."

    if existing:
        cur.execute("""
            UPDATE submissions
            SET submitted_answer = ?, wager_points = ?, submitted_at = ?
            WHERE id = ?
        """, (submitted_answer, wager_points, now, existing["id"]))
    else:
        cur.execute("""
            INSERT INTO submissions (team_id, round_num, question_num, half,
                                     submitted_answer, wager_points, submitted_at,
                                     is_correct, awarded_points)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
        """, (team_id, gs["current_round"], gs["current_question"], gs["half"],
              submitted_answer, wager_points, now))
    conn.commit()
    return True, "Answer saved."

def fetch_submissions_for_current(conn, gs):
    cur = conn.cursor()
    cur.execute("""
    SELECT s.*, t.team_name
    FROM submissions s
    JOIN teams t ON t.id = s.team_id
    WHERE s.round_num = ? AND s.question_num = ?
    ORDER BY s.submitted_at ASC
    """, (gs["current_round"], gs["current_question"]))
    return [dict(r) for r in cur.fetchall()]

def grade_submission(conn, submission_id: int, correct: bool, awarded_points: int | None = None):
    cur = conn.cursor()
    cur.execute("SELECT * FROM submissions WHERE id = ?", (submission_id,))
    s = cur.fetchone()
    if not s:
        return

    if awarded_points is None:
        awarded_points = s["wager_points"] if correct else 0

    cur.execute("""
        UPDATE submissions
        SET is_correct = ?, awarded_points = ?, graded_at = ?
        WHERE id = ?
    """, (1 if correct else 0, int(awarded_points), datetime.utcnow().isoformat(), submission_id))
    conn.commit()

# -----------------------------
# UI
# -----------------------------
st.set_page_config(page_title="Pub Trivia", layout="wide")
init_db()

conn = get_conn()
gs = get_game_state(conn)

st.title("🍻 Pub Trivia")

# Sidebar: team login / creation
with st.sidebar:
    st.header("Team Login")
    team_name = st.text_input("Team name", value=st.session_state.get("team_name", ""))
    team_pass = st.text_input("Team password", type="password")

    if st.button("Enter / Create Team"):
        team, err = get_or_create_team(conn, team_name, team_pass)
        if err:
            st.error(err)
        else:
            st.session_state["team_id"] = team["id"]
            st.session_state["team_name"] = team["team_name"]
            st.success(f"Welcome, {team['team_name']}!")

    st.divider()
    st.header("Admin Login")
    admin_pass = st.text_input("Admin password", type="password", key="admin_pass")
    if st.button("Enter Admin"):
        real_admin = st.secrets.get("ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD)
        st.session_state["is_admin"] = (admin_pass == real_admin)
        if st.session_state["is_admin"]:
            st.success("Admin mode enabled.")
        else:
            st.error("Wrong admin password.")

team_id = st.session_state.get("team_id")
team_logged_in = team_id is not None
is_admin = bool(st.session_state.get("is_admin", False))

tab1, tab2, tab3 = st.tabs(["📊 Scoreboard", "✍️ Submit Answer", "🛠️ Admin"])

# -----------------------------
# Tab 1: Scoreboard
# -----------------------------
with tab1:
    colA, colB = st.columns([2, 1])
    with colA:
        st.subheader("Scoreboard")
        scores = compute_scores(conn)
        st.dataframe(
            [{"Team": s["team_name"], "Score": s["score"]} for s in scores],
            use_container_width=True,
            hide_index=True,
        )
    with colB:
        st.subheader("Game Status")
        st.write(f"**Round:** {gs['current_round']}")
        st.write(f"**Question:** {gs['current_question']}")
        st.write(f"**Half:** {gs['half']} (wagers: {allowed_wagers(gs['half'])})")
        st.write(f"**Submissions:** {'OPEN ✅' if gs['submissions_open'] else 'CLOSED ⛔'}")
        st.write(f"**Answer revealed:** {'YES ✅' if gs['revealed'] else 'NO'}")

    # lightweight auto-refresh
    st.caption(f"Auto-refresh every {AUTO_REFRESH_SECONDS}s")
    time.sleep(AUTO_REFRESH_SECONDS)
    st.rerun()

# -----------------------------
# Tab 2: Submit Answer (Teams)
# -----------------------------
with tab2:
    st.subheader("Submit Your Answer")

    if not team_logged_in:
        st.info("Enter your team name + password in the sidebar to submit.")
    else:
        gs = get_game_state(conn)  # refresh
        if not gs["submissions_open"]:
            st.warning("Submissions are currently closed.")
        else:
            st.write(f"**Round {gs['current_round']} — Question {gs['current_question']} (Half {gs['half']})**")
            if gs["question_text"].strip():
                st.markdown(f"### ❓ {gs['question_text']}")
            else:
                st.markdown("### ❓ (Host hasn’t posted the question text yet)")

            wager_opts = allowed_wagers(gs["half"])
            answer_text = st.text_input("Your answer")
            wager = st.selectbox("How many points are you wagering?", wager_opts, index=0)

            if st.button("Submit / Update Answer"):
                if not answer_text.strip():
                    st.error("Answer can’t be empty.")
                else:
                    ok, msg = upsert_submission(conn, team_id, gs, answer_text.strip(), int(wager))
                    (st.success if ok else st.error)(msg)

        if gs["revealed"] and gs["answer_text"].strip():
            st.divider()
            st.markdown(f"### ✅ Official Answer: {gs['answer_text']}")

# -----------------------------
# Tab 3: Admin
# -----------------------------
with tab3:
    st.subheader("Admin Controls")

    if not is_admin:
        st.info("Enter the admin password in the sidebar to access host tools.")
    else:
        gs = get_game_state(conn)

        col1, col2 = st.columns([2, 1])

        with col1:
            st.markdown("### Question Setup")
            q_text = st.text_area("Question text (what teams see)", value=gs["question_text"], height=100)
            a_text = st.text_input("Official answer (revealed when you choose)", value=gs["answer_text"])

            cA, cB, cC, cD = st.columns(4)
            with cA:
                if st.button("Save Question/Answer"):
                    set_game_state(conn, question_text=q_text, answer_text=a_text)
                    st.success("Saved.")
            with cB:
                if st.button("Open Submissions ✅"):
                    set_game_state(conn, submissions_open=1, revealed=0)
                    st.success("Submissions opened.")
            with cC:
                if st.button("Close Submissions ⛔"):
                    set_game_state(conn, submissions_open=0)
                    st.success("Submissions closed.")
            with cD:
                if st.button("Reveal Answer 👀"):
                    set_game_state(conn, revealed=1)
                    st.success("Answer revealed.")

        with col2:
            st.markdown("### Progress Game")
            new_round = st.number_input("Round", min_value=1, value=int(gs["current_round"]), step=1)
            new_q = st.number_input("Question", min_value=1, value=int(gs["current_question"]), step=1)
            new_half = st.selectbox("Half", [1, 2], index=0 if gs["half"] == 1 else 1)

            if st.button("Jump to this (Round/Question/Half)"):
                set_game_state(conn,
                               current_round=int(new_round),
                               current_question=int(new_q),
                               half=int(new_half),
                               submissions_open=0,
                               revealed=0)
                st.success("Game position updated (submissions closed, answer hidden).")

            if st.button("Next Question ➡️"):
                set_game_state(conn,
                               current_question=int(gs["current_question"]) + 1,
                               submissions_open=0,
                               revealed=0)
                st.success("Advanced to next question.")

        st.divider()
        st.markdown("### Grade Submissions (Current Question)")

        gs = get_game_state(conn)
        subs = fetch_submissions_for_current(conn, gs)

        if not subs:
            st.info("No submissions yet for the current question.")
        else:
            for s in subs:
                with st.container(border=True):
                    left, right = st.columns([3, 2])
                    with left:
                        st.write(f"**{s['team_name']}** — wager **{s['wager_points']}**")
                        st.write(f"Answer: {s['submitted_answer']}")
                        status = "UNGRADED" if s["is_correct"] is None else ("✅ CORRECT" if s["is_correct"] == 1 else "❌ WRONG")
                        st.caption(f"Status: {status} | Awarded: {s['awarded_points']}")

                    with right:
                        c1, c2, c3 = st.columns(3)
                        with c1:
                            if st.button("Mark ✅", key=f"ok_{s['id']}"):
                                grade_submission(conn, s["id"], correct=True, awarded_points=None)
                                st.rerun()
                        with c2:
                            if st.button("Mark ❌", key=f"bad_{s['id']}"):
                                grade_submission(conn, s["id"], correct=False, awarded_points=None)
                                st.rerun()
                        with c3:
                            new_award = st.number_input("Edit award", min_value=0, value=int(s["awarded_points"]),
                                                        step=1, key=f"award_{s['id']}")
                            if st.button("Set", key=f"set_{s['id']}"):
                                # Keep correctness as-is if already graded; if ungraded, assume "correct" when awarding > 0
                                correct_guess = (s["is_correct"] == 1) if s["is_correct"] is not None else (new_award > 0)
                                grade_submission(conn, s["id"], correct=correct_guess, awarded_points=int(new_award))
                                st.rerun()

conn.close()
