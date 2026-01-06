# app.py — Pub Trivia (Streamlit + SQLite)
# Router-first structure to guarantee the landing page loads first.

import sqlite3
import hashlib
from datetime import datetime
import csv
import io
import secrets
import string

import streamlit as st

DB_PATH = "trivia.db"
DEFAULT_ADMIN_PASSWORD = "changeme"  # Prefer: .streamlit/secrets.toml -> ADMIN_PASSWORD="..."

# -----------------------------
# Utilities
# -----------------------------
def sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def now_iso() -> str:
    return datetime.utcnow().isoformat()

def generate_temp_password(length: int = 8) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))

# -----------------------------
# DB
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
        half INTEGER NOT NULL DEFAULT 1,
        question_text TEXT NOT NULL DEFAULT '',
        answer_text TEXT NOT NULL DEFAULT '',
        submissions_open INTEGER NOT NULL DEFAULT 0,
        revealed INTEGER NOT NULL DEFAULT 0,
        allow_new_teams INTEGER NOT NULL DEFAULT 1,
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
        is_correct INTEGER,
        awarded_points INTEGER NOT NULL DEFAULT 0,
        graded_at TEXT,
        UNIQUE(team_id, round_num, question_num),
        FOREIGN KEY(team_id) REFERENCES teams(id)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS question_bank (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        q_number INTEGER NOT NULL UNIQUE,
        category TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        note TEXT
    )
    """)

    # Ensure game_state singleton row exists
    cur.execute("SELECT id FROM game_state WHERE id=1")
    if not cur.fetchone():
        cur.execute("""
        INSERT INTO game_state (
            id, current_round, current_question, half,
            question_text, answer_text, submissions_open, revealed, allow_new_teams, updated_at
        )
        VALUES (1, 1, 1, 1, '', '', 0, 0, 1, ?)
        """, (now_iso(),))

    conn.commit()
    conn.close()

# -----------------------------
# DB: game state
# -----------------------------
def get_game_state(conn):
    cur = conn.cursor()
    cur.execute("SELECT * FROM game_state WHERE id=1")
    return dict(cur.fetchone())

def set_game_state(conn, **kwargs):
    allowed = {
        "current_round", "current_question", "half",
        "question_text", "answer_text",
        "submissions_open", "revealed", "allow_new_teams"
    }
    keys = [k for k in kwargs.keys() if k in allowed]
    if not keys:
        return
    parts = ", ".join([f"{k}=?" for k in keys] + ["updated_at=?"])
    vals = [kwargs[k] for k in keys] + [now_iso()]
    cur = conn.cursor()
    cur.execute(f"UPDATE game_state SET {parts} WHERE id=1", vals)
    conn.commit()

def allowed_wagers(half: int):
    return [1, 3, 5] if int(half) == 1 else [2, 4, 6]

# -----------------------------
# DB: teams/auth
# -----------------------------
def get_or_create_team(conn, team_name: str, password: str):
    gs = get_game_state(conn)
    allow_new = bool(gs["allow_new_teams"])

    team_name = (team_name or "").strip()
    password = password or ""

    if not team_name:
        return None, "Team name cannot be empty."
    if len(password) < 4:
        return None, "Password must be at least 4 characters."

    cur = conn.cursor()
    cur.execute("SELECT * FROM teams WHERE team_name=?", (team_name,))
    row = cur.fetchone()

    if row:
        if row["pass_hash"] != sha256(password):
            return None, "Incorrect password."
        return dict(row), None

    if not allow_new:
        return None, "New team creation is disabled. Please log in with an existing team."

    try:
        cur.execute(
            "INSERT INTO teams (team_name, pass_hash, created_at) VALUES (?, ?, ?)",
            (team_name, sha256(password), now_iso())
        )
        conn.commit()
    except sqlite3.IntegrityError:
        return None, "That team name was just taken. Try again."

    cur.execute("SELECT * FROM teams WHERE team_name=?", (team_name,))
    return dict(cur.fetchone()), None

def list_teams(conn):
    cur = conn.cursor()
    cur.execute("SELECT id, team_name, created_at FROM teams ORDER BY team_name ASC")
    return [dict(r) for r in cur.fetchall()]

def admin_set_team_password(conn, team_id: int, new_password: str):
    if len(new_password or "") < 4:
        return False, "Password must be at least 4 characters."
    cur = conn.cursor()
    cur.execute("UPDATE teams SET pass_hash=? WHERE id=?", (sha256(new_password), team_id))
    conn.commit()
    return True, "Password updated."

def admin_delete_team(conn, team_id: int):
    cur = conn.cursor()
    cur.execute("DELETE FROM submissions WHERE team_id=?", (team_id,))
    cur.execute("DELETE FROM teams WHERE id=?", (team_id,))
    conn.commit()

# -----------------------------
# DB: scoring/submissions
# -----------------------------
def compute_scores(conn):
    cur = conn.cursor()
    cur.execute("""
    SELECT t.team_name, COALESCE(SUM(s.awarded_points), 0) AS score
    FROM teams t
    LEFT JOIN submissions s ON s.team_id = t.id
    GROUP BY t.id, t.team_name
    ORDER BY score DESC, t.team_name ASC
    """)
    return [dict(r) for r in cur.fetchall()]

def upsert_submission(conn, team_id: int, gs: dict, answer: str, wager: int):
    answer = (answer or "").strip()
    if not answer:
        return False, "Answer can’t be empty."

    cur = conn.cursor()
    cur.execute("""
      SELECT * FROM submissions
      WHERE team_id=? AND round_num=? AND question_num=?
    """, (team_id, gs["current_round"], gs["current_question"]))
    existing = cur.fetchone()

    if existing and existing["is_correct"] is not None:
        return False, "This question is already graded; you can’t change your answer."

    if existing:
        cur.execute("""
          UPDATE submissions
          SET submitted_answer=?, wager_points=?, submitted_at=?
          WHERE id=?
        """, (answer, int(wager), now_iso(), existing["id"]))
    else:
        cur.execute("""
          INSERT INTO submissions (
            team_id, round_num, question_num, half,
            submitted_answer, wager_points, submitted_at,
            is_correct, awarded_points
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
        """, (team_id, gs["current_round"], gs["current_question"], gs["half"],
              answer, int(wager), now_iso()))
    conn.commit()
    return True, "Saved."

def fetch_submissions_for_current(conn, gs: dict):
    cur = conn.cursor()
    cur.execute("""
      SELECT s.*, t.team_name
      FROM submissions s
      JOIN teams t ON t.id=s.team_id
      WHERE s.round_num=? AND s.question_num=?
      ORDER BY s.submitted_at ASC
    """, (gs["current_round"], gs["current_question"]))
    return [dict(r) for r in cur.fetchall()]

def grade_submission(conn, submission_id: int, correct: bool, awarded_points: int | None = None):
    cur = conn.cursor()
    cur.execute("SELECT * FROM submissions WHERE id=?", (submission_id,))
    s = cur.fetchone()
    if not s:
        return
    if awarded_points is None:
        awarded_points = s["wager_points"] if correct else 0
    cur.execute("""
      UPDATE submissions
      SET is_correct=?, awarded_points=?, graded_at=?
      WHERE id=?
    """, (1 if correct else 0, int(awarded_points), now_iso(), submission_id))
    conn.commit()

# -----------------------------
# DB: question bank CSV
# -----------------------------
def parse_question_csv(uploaded_file):
    required = ["Number", "Category", "Question", "Answer", "Note"]
    errors = []

    data = uploaded_file.getvalue().decode("utf-8-sig", errors="replace")
    f = io.StringIO(data)
    reader = csv.DictReader(f)

    header = [h.strip() for h in (reader.fieldnames or [])]
    if header != required:
        return [], [f"CSV header must be exactly: {', '.join(required)}"]

    rows = []
    for i, row in enumerate(reader, start=2):
        try:
            qn = int((row.get("Number") or "").strip())
        except Exception:
            errors.append(f"Row {i}: Number must be an integer.")
            continue
        cat = (row.get("Category") or "").strip()
        q = (row.get("Question") or "").strip()
        a = (row.get("Answer") or "").strip()
        n = (row.get("Note") or "").strip()

        if not cat or not q or not a:
            errors.append(f"Row {i}: Category, Question, Answer are required.")
            continue

        rows.append({"q_number": qn, "category": cat, "question": q, "answer": a, "note": n})

    return rows, errors

def upsert_question_bank_rows(conn, rows):
    cur = conn.cursor()
    for r in rows:
        cur.execute("""
          INSERT INTO question_bank (q_number, category, question, answer, note)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(q_number) DO UPDATE SET
            category=excluded.category,
            question=excluded.question,
            answer=excluded.answer,
            note=excluded.note
        """, (r["q_number"], r["category"], r["question"], r["answer"], r["note"]))
    conn.commit()

def get_question_index(conn):
    cur = conn.cursor()
    cur.execute("SELECT q_number, category FROM question_bank ORDER BY q_number ASC")
    return [dict(r) for r in cur.fetchall()]

def get_question_by_number(conn, q_number: int):
    cur = conn.cursor()
    cur.execute("SELECT q_number, category, question, answer, note FROM question_bank WHERE q_number=?",
                (int(q_number),))
    row = cur.fetchone()
    return dict(row) if row else None

# -----------------------------
# Router / session
# -----------------------------
def hard_reset_session():
    for k in ["route", "role", "team_id", "team_name", "is_admin"]:
        st.session_state.pop(k, None)

def set_route(route: str):
    st.session_state["route"] = route

def get_route() -> str:
    # landing, team_login, admin_login, app_team, app_admin
    return st.session_state.get("route", "landing")

# -----------------------------
# UI: Pages
# -----------------------------
def page_landing():
    st.header("Welcome to Pub Trivia 🍻")
    st.write("Choose how you want to enter:")

    c1, c2 = st.columns(2)
    with c1:
        if st.button("👥 Team"):
            set_route("team_login")
            st.rerun()
    with c2:
        if st.button("🛠️ Admin"):
            set_route("admin_login")
            st.rerun()

    st.divider()
    st.caption("Teams use Team Name + Password. Admin uses the host password.")

def page_team_login(conn):
    st.header("Team Login")
    st.write("Enter your team name + password. If the team doesn’t exist, it will be created (unless disabled by admin).")

    team_name = st.text_input("Team name")
    team_pass = st.text_input("Team password", type="password")

    colA, colB = st.columns([1, 1])
    with colA:
        if st.button("Enter / Create"):
            team, err = get_or_create_team(conn, team_name, team_pass)
            if err:
                st.error(err)
            else:
                st.session_state["role"] = "team"
                st.session_state["team_id"] = team["id"]
                st.session_state["team_name"] = team["team_name"]
                set_route("app_team")
                st.rerun()
    with colB:
        if st.button("← Back"):
            set_route("landing")
            st.rerun()

def page_admin_login():
    st.header("Admin Login")
    admin_pass = st.text_input("Admin password", type="password")

    colA, colB = st.columns([1, 1])
    with colA:
        if st.button("Enter Admin"):
            real = st.secrets.get("ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD)
            if admin_pass == real:
                st.session_state["role"] = "admin"
                st.session_state["is_admin"] = True
                set_route("app_admin")
                st.rerun()
            else:
                st.error("Wrong admin password.")
    with colB:
        if st.button("← Back"):
            set_route("landing")
            st.rerun()

def render_scoreboard(conn, gs, who: str):
    header_left, header_right = st.columns([3, 1])
    with header_left:
        st.subheader("Scoreboard")
    with header_right:
        if st.button("🔄 Refresh"):
            st.rerun()

    colA, colB = st.columns([2, 1])
    with colA:
        scores = compute_scores(conn)
        st.dataframe(
            [{"Team": r["team_name"], "Score": r["score"]} for r in scores],
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
        st.write(f"**New teams allowed:** {'YES ✅' if gs['allow_new_teams'] else 'NO ⛔'}")

    st.caption(f"Logged in as: {who}")

    if gs["revealed"] and gs["answer_text"].strip():
        st.divider()
        st.markdown(f"### ✅ Official Answer: {gs['answer_text']}")

def page_app_team(conn):
    gs = get_game_state(conn)
    who = f"Team — {st.session_state.get('team_name', '')}"

    tab1, tab2 = st.tabs(["📊 Scoreboard", "✍️ Submit Answer"])

    with tab1:
        render_scoreboard(conn, gs, who)

    with tab2:
        st.subheader("Submit Answer")
        gs = get_game_state(conn)

        if not gs["submissions_open"]:
            st.warning("Submissions are currently closed.")
        else:
            if gs["question_text"].strip():
                st.markdown(f"### ❓ {gs['question_text']}")
            else:
                st.markdown("### ❓ (Host hasn’t posted the question text yet)")

            wager_opts = allowed_wagers(gs["half"])
            answer = st.text_input("Your answer")
            wager = st.selectbox("Wager points", wager_opts, index=0)

            if st.button("Submit / Update"):
                ok, msg = upsert_submission(conn, int(st.session_state["team_id"]), gs, answer, int(wager))
                (st.success if ok else st.error)(msg)

        if gs["revealed"] and gs["answer_text"].strip():
            st.divider()
            st.markdown(f"### ✅ Official Answer: {gs['answer_text']}")

def page_app_admin(conn):
    gs = get_game_state(conn)
    who = "Admin"

    tab1, tab2 = st.tabs(["📊 Scoreboard", "🛠️ Admin"])
    with tab1:
        render_scoreboard(conn, gs, who)

    with tab2:
        st.subheader("Admin Controls")

        # Settings
        st.markdown("### Settings")
        allow = st.toggle("Allow new team creation", value=bool(gs["allow_new_teams"]))
        if st.button("Save Settings"):
            set_game_state(conn, allow_new_teams=1 if allow else 0)
            st.success("Saved.")
            st.rerun()

        st.divider()

        # Team manager
        st.markdown("### Team Manager")
        teams = list_teams(conn)
        if not teams:
            st.info("No teams yet.")
        else:
            names = [t["team_name"] for t in teams]
            selected = st.selectbox("Select team", names)
            t = next(x for x in teams if x["team_name"] == selected)

            st.write(f"**Team:** {t['team_name']}")
            st.caption(f"Created: {t['created_at']}")

            col1, col2 = st.columns(2)
            with col1:
                pw = st.text_input("Set new password", type="password")
                if st.button("Set Password"):
                    ok, msg = admin_set_team_password(conn, t["id"], pw)
                    (st.success if ok else st.error)(msg)

            with col2:
                if st.button("Generate Temp Password"):
                    temp = generate_temp_password(8)
                    ok, msg = admin_set_team_password(conn, t["id"], temp)
                    if ok:
                        st.success(f"Temp password for **{t['team_name']}**: **{temp}**")
                    else:
                        st.error(msg)

            cdel1, cdel2 = st.columns([1, 2])
            with cdel1:
                confirm = st.checkbox("Confirm delete")
            with cdel2:
                if st.button("Delete Team (and submissions)"):
                    if not confirm:
                        st.error("Check confirm first.")
                    else:
                        admin_delete_team(conn, t["id"])
                        st.success("Deleted.")
                        st.rerun()

        st.divider()

        # CSV upload
        st.markdown("### Upload Question Bank (CSV)")
        st.caption("Header must be exactly: Number, Category, Question, Answer, Note")
        uploaded = st.file_uploader("Upload CSV", type=["csv"])
        if uploaded is not None:
            rows, errs = parse_question_csv(uploaded)
            if errs:
                st.error("CSV issues:")
                for e in errs[:20]:
                    st.write(f"- {e}")
            else:
                upsert_question_bank_rows(conn, rows)
                st.success(f"Loaded {len(rows)} questions.")
                st.rerun()

        # Question index grouped by 3
        st.divider()
        st.markdown("### Question Index (Number / Category)")
        idx = get_question_index(conn)
        if not idx:
            st.info("No questions loaded yet.")
        else:
            nums = [r["q_number"] for r in idx]
            min_q, max_q = min(nums), max(nums)
            start = min_q - ((min_q - 1) % 3)

            for block_start in range(start, max_q + 1, 3):
                block_end = block_start + 2
                block = [r for r in idx if block_start <= r["q_number"] <= block_end]
                if not block:
                    continue
                with st.container(border=True):
                    st.write(f"**{block_start}–{block_end}**")
                    for r in block:
                        st.write(f"- {r['q_number']}: {r['category']}")

        st.divider()

        # Live question controls
        st.markdown("### Live Question Controls")
        gs = get_game_state(conn)

        cA, cB = st.columns([2, 1])
        with cB:
            st.markdown("#### Load from Bank")
            pick = st.number_input("Question #", min_value=1, value=int(gs["current_question"]), step=1)
            if st.button("Load into Live Game"):
                qrow = get_question_by_number(conn, int(pick))
                if not qrow:
                    st.error("That question number isn’t in the bank.")
                else:
                    q_text = f"[{qrow['category']}] {qrow['question']}"
                    set_game_state(conn, question_text=q_text, answer_text=qrow["answer"])
                    st.success("Loaded.")
                    st.rerun()

        with cA:
            q_text = st.text_area("Question text (what teams see)", value=gs["question_text"], height=110)
            a_text = st.text_input("Official answer", value=gs["answer_text"])

            b1, b2, b3, b4 = st.columns(4)
            with b1:
                if st.button("Save Q/A"):
                    set_game_state(conn, question_text=q_text, answer_text=a_text)
                    st.success("Saved.")
            with b2:
                if st.button("Open Submissions ✅"):
                    set_game_state(conn, submissions_open=1, revealed=0)
                    st.success("Open.")
            with b3:
                if st.button("Close Submissions ⛔"):
                    set_game_state(conn, submissions_open=0)
                    st.success("Closed.")
            with b4:
                if st.button("Reveal Answer 👀"):
                    set_game_state(conn, revealed=1)
                    st.success("Revealed.")

        st.divider()

        # Progress game
        st.markdown("### Progress Game")
        gs = get_game_state(conn)
        colP1, colP2 = st.columns([2, 1])
        with colP2:
            new_round = st.number_input("Round", min_value=1, value=int(gs["current_round"]), step=1, key="r2")
            new_q = st.number_input("Question", min_value=1, value=int(gs["current_question"]), step=1, key="q2")
            new_half = st.selectbox("Half", [1, 2], index=0 if int(gs["half"]) == 1 else 1, key="h2")

            if st.button("Jump"):
                set_game_state(conn, current_round=int(new_round), current_question=int(new_q),
                               half=int(new_half), submissions_open=0, revealed=0)
                st.success("Jumped.")
                st.rerun()

            if st.button("Next Question ➡️"):
                set_game_state(conn, current_question=int(gs["current_question"]) + 1,
                               submissions_open=0, revealed=0)
                st.success("Next.")
                st.rerun()

        with colP1:
            st.markdown("### Grade Submissions (Current Question)")
            subs = fetch_submissions_for_current(conn, gs)

            if not subs:
                st.info("No submissions yet.")
            else:
                for s in subs:
                    with st.container(border=True):
                        L, R = st.columns([3, 2])
                        with L:
                            st.write(f"**{s['team_name']}** — wager **{s['wager_points']}**")
                            st.write(f"Answer: {s['submitted_answer']}")
                            status = "UNGRADED" if s["is_correct"] is None else ("✅ CORRECT" if s["is_correct"] == 1 else "❌ WRONG")
                            st.caption(f"Status: {status} | Awarded: {s['awarded_points']}")

                        with R:
                            x1, x2, x3 = st.columns(3)
                            with x1:
                                if st.button("Mark ✅", key=f"ok_{s['id']}"):
                                    grade_submission(conn, s["id"], True)
                                    st.rerun()
                            with x2:
                                if st.button("Mark ❌", key=f"bad_{s['id']}"):
                                    grade_submission(conn, s["id"], False)
                                    st.rerun()
                            with x3:
                                new_award = st.number_input("Edit award", min_value=0,
                                                            value=int(s["awarded_points"]),
                                                            step=1, key=f"award_{s['id']}")
                                if st.button("Set", key=f"set_{s['id']}"):
                                    correct_guess = (s["is_correct"] == 1) if s["is_correct"] is not None else (new_award > 0)
                                    grade_submission(conn, s["id"], bool(correct_guess), int(new_award))
                                    st.rerun()

# -----------------------------
# App boot
# -----------------------------
st.set_page_config(page_title="Pub Trivia", layout="wide")
init_db()

# Global header controls (always rendered)
topL, topR = st.columns([5, 1])
with topL:
    st.title("🍻 Pub Trivia")
with topR:
    if st.button("Reset App Session"):
        hard_reset_session()
        st.rerun()

# Open DB once per run
conn = get_conn()

# Always show a safe debug hint (optional)
# st.caption(f"Route: {get_route()}")

# Router
route = get_route()

if route == "landing":
    page_landing()
elif route == "team_login":
    page_team_login(conn)
elif route == "admin_login":
    page_admin_login()
elif route == "app_team":
    # guard
    if st.session_state.get("team_id") is None:
        set_route("team_login")
        st.rerun()
    page_app_team(conn)
elif route == "app_admin":
    if not st.session_state.get("is_admin", False):
        set_route("admin_login")
        st.rerun()
    page_app_admin(conn)
else:
    # fallback to landing if something weird happens
    hard_reset_session()
    set_route("landing")
    st.rerun()

conn.close()
