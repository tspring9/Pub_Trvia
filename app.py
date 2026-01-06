# app.py
# Pub Trivia / Bar Trivia app (Streamlit + SQLite)
#
# NEW FLOW (per your request):
# - Landing page: choose "Team" or "Admin"
# - If Team: prompt team name + password (create/login; creation can be disabled by admin toggle)
# - If Admin: prompt admin password
# - After login:
#     - Teams see tabs: Scoreboard (home), Submit Answer
#     - Admins see tabs: Scoreboard (home), Admin
#
# Admin features:
# - Toggle: allow/disable NEW team creation (existing teams can still log in)
# - Team manager: view teams, reset/set password (including generate temp password), delete team (optional)
# - Upload CSV question bank: columns exactly Number,Category,Question,Answer,Note
# - Display question index grouped by 3 (1–3, 4–6, ...)
# - Load a question from bank into live game_state
# - Set question/answer manually, open/close submissions, reveal answer
# - Progress game: jump round/question/half, next question
# - Grade submissions: mark correct/incorrect, override awarded points
#
# Team features:
# - See live game status + scoreboard
# - Submit/update answer while submissions are open (cannot edit after grading)
# - See official answer after reveal
#
# IMPORTANT:
# - No auto-rerun loop (it breaks Admin UI). Use manual refresh buttons instead.

import sqlite3
import hashlib
from datetime import datetime
import csv
import io
import secrets
import string

import streamlit as st

DB_PATH = "trivia.db"

# -----------------------------
# Config
# -----------------------------
DEFAULT_ADMIN_PASSWORD = "changeme"  # Prefer: .streamlit/secrets.toml -> ADMIN_PASSWORD="..."
# -----------------------------
# DB helpers
# -----------------------------
def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def init_db():
    conn = get_conn()
    cur = conn.cursor()

    # Teams
    cur.execute("""
    CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_name TEXT NOT NULL UNIQUE,
        pass_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    """)

    # Game state (single row)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_round INTEGER NOT NULL DEFAULT 1,
        current_question INTEGER NOT NULL DEFAULT 1,
        half INTEGER NOT NULL DEFAULT 1,               -- 1 or 2
        question_text TEXT NOT NULL DEFAULT '',
        answer_text TEXT NOT NULL DEFAULT '',
        submissions_open INTEGER NOT NULL DEFAULT 0,   -- 0/1
        revealed INTEGER NOT NULL DEFAULT 0,           -- 0/1
        updated_at TEXT NOT NULL DEFAULT ''
    )
    """)

    # Submissions
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
        is_correct INTEGER,                 -- NULL until graded; 0/1 after graded
        awarded_points INTEGER NOT NULL DEFAULT 0,
        graded_at TEXT,
        UNIQUE(team_id, round_num, question_num),
        FOREIGN KEY(team_id) REFERENCES teams(id)
    )
    """)

    # Ensure game_state row exists
    cur.execute("SELECT id FROM game_state WHERE id = 1")
    if not cur.fetchone():
        cur.execute("""
        INSERT INTO game_state (
            id, current_round, current_question, half,
            question_text, answer_text, submissions_open, revealed, updated_at
        )
        VALUES (1, 1, 1, 1, '', '', 0, 0, ?)
        """, (datetime.utcnow().isoformat(),))

    # Add allow_new_teams flag if missing (migration)
    cur.execute("PRAGMA table_info(game_state)")
    gs_cols = [r[1] for r in cur.fetchall()]
    if "allow_new_teams" not in gs_cols:
        cur.execute("ALTER TABLE game_state ADD COLUMN allow_new_teams INTEGER NOT NULL DEFAULT 1")

    # Question bank
    cur.execute("""
    CREATE TABLE IF NOT EXISTS question_bank (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        q_number INTEGER NOT NULL,
        category TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        note TEXT,
        UNIQUE(q_number)
    )
    """)

    conn.commit()
    conn.close()


def get_game_state(conn):
    cur = conn.cursor()
    cur.execute("SELECT * FROM game_state WHERE id=1")
    return cur.fetchone()


def set_game_state(conn, **kwargs):
    allowed = {
        "current_round", "current_question", "half",
        "question_text", "answer_text",
        "submissions_open", "revealed", "allow_new_teams",
        "updated_at"
    }
    keys = [k for k in kwargs.keys() if k in allowed]
    if not keys:
        return
    parts = ", ".join([f"{k} = ?" for k in keys] + ["updated_at = ?"])
    values = [kwargs[k] for k in keys] + [datetime.utcnow().isoformat()]
    cur = conn.cursor()
    cur.execute(f"UPDATE game_state SET {parts} WHERE id=1", values)
    conn.commit()


def allowed_wagers(half: int):
    return [1, 3, 5] if half == 1 else [2, 4, 6]


def get_or_create_team(conn, team_name: str, password: str, allow_new_teams: bool):
    team_name = (team_name or "").strip()
    password = password or ""

    if not team_name:
        return None, "Team name cannot be empty."
    if len(password) < 4:
        return None, "Password must be at least 4 characters."

    cur = conn.cursor()
    cur.execute("SELECT * FROM teams WHERE team_name = ?", (team_name,))
    existing = cur.fetchone()

    if existing:
        if existing["pass_hash"] != sha256(password):
            return None, "Incorrect password for that team name."
        return dict(existing), None

    if not allow_new_teams:
        return None, "New team creation is currently disabled. Please log in with an existing team."

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


def upsert_submission(conn, team_id: int, gs, submitted_answer: str, wager_points: int):
    cur = conn.cursor()
    now = datetime.utcnow().isoformat()

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
            INSERT INTO submissions (
                team_id, round_num, question_num, half,
                submitted_answer, wager_points, submitted_at,
                is_correct, awarded_points
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
        """, (
            team_id, gs["current_round"], gs["current_question"], gs["half"],
            submitted_answer, wager_points, now
        ))

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


# -----------------------------
# Admin: teams
# -----------------------------
def list_teams(conn):
    cur = conn.cursor()
    cur.execute("SELECT id, team_name, created_at FROM teams ORDER BY team_name ASC")
    return [dict(r) for r in cur.fetchall()]


def admin_set_team_password(conn, team_id: int, new_password: str):
    if len(new_password or "") < 4:
        return False, "Password must be at least 4 characters."
    cur = conn.cursor()
    cur.execute("UPDATE teams SET pass_hash = ? WHERE id = ?", (sha256(new_password), team_id))
    conn.commit()
    return True, "Password updated."


def admin_delete_team(conn, team_id: int):
    cur = conn.cursor()
    cur.execute("DELETE FROM submissions WHERE team_id = ?", (team_id,))
    cur.execute("DELETE FROM teams WHERE id = ?", (team_id,))
    conn.commit()


def generate_temp_password(length: int = 8) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


# -----------------------------
# Admin: question bank CSV
# -----------------------------
def parse_question_csv(uploaded_file) -> tuple[list[dict], list[str]]:
    """
    Expects columns exactly:
      Number, Category, Question, Answer, Note
    """
    errors: list[str] = []
    data = uploaded_file.getvalue().decode("utf-8-sig", errors="replace")
    f = io.StringIO(data)
    reader = csv.DictReader(f)

    required = ["Number", "Category", "Question", "Answer", "Note"]
    header = [h.strip() for h in (reader.fieldnames or [])]
    if header != required:
        errors.append(f"CSV header must be exactly: {', '.join(required)}")
        return [], errors

    rows: list[dict] = []
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
            errors.append(f"Row {i}: Category, Question, and Answer are required.")
            continue

        rows.append({
            "q_number": qn,
            "category": cat,
            "question": q,
            "answer": a,
            "note": n
        })

    return rows, errors


def upsert_question_bank_rows(conn, rows: list[dict]):
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
    cur.execute("""
        SELECT q_number, category, question, answer, note
        FROM question_bank
        WHERE q_number = ?
    """, (q_number,))
    row = cur.fetchone()
    return dict(row) if row else None


# -----------------------------
# Session helpers
# -----------------------------
def logout():
    st.session_state.pop("role", None)
    st.session_state.pop("team_id", None)
    st.session_state.pop("team_name", None)
    st.session_state.pop("is_admin", None)


# -----------------------------
# UI
# -----------------------------
st.set_page_config(page_title="Pub Trivia", layout="wide")
init_db()

conn = get_conn()
gs = get_game_state(conn)

st.title("🍻 Pub Trivia")

# Top-right-ish controls
top_left, top_right = st.columns([5, 1])
with top_right:
    if st.session_state.get("role"):
        if st.button("Log out"):
            logout()
            st.rerun()

role = st.session_state.get("role")  # None, "team", "admin"

# -----------------------------
# Landing page (role selection)
# -----------------------------
if role is None:
    st.subheader("Welcome")
    st.write("Select how you want to enter:")

    c1, c2 = st.columns(2)
    with c1:
        if st.button("👥 Team"):
            st.session_state["role"] = "team"
            st.rerun()
    with c2:
        if st.button("🛠️ Admin"):
            st.session_state["role"] = "admin"
            st.rerun()

    st.divider()

    st.info("Tip: Teams use their team name + password. Admin uses the host password.")
    conn.close()
    st.stop()

# -----------------------------
# Team login screen
# -----------------------------
if role == "team" and st.session_state.get("team_id") is None:
    st.subheader("Team Login")
    team_name = st.text_input("Team name", value=st.session_state.get("team_name", ""))
    team_pass = st.text_input("Team password", type="password")

    if st.button("Enter / Create Team"):
        gs = get_game_state(conn)
        team, err = get_or_create_team(
            conn,
            team_name=team_name,
            password=team_pass,
            allow_new_teams=bool(gs["allow_new_teams"])
        )
        if err:
            st.error(err)
        else:
            st.session_state["team_id"] = team["id"]
            st.session_state["team_name"] = team["team_name"]
            st.success(f"Welcome, {team['team_name']}!")
            st.rerun()

    st.caption("If your browser refreshes, just log back in with the same team name + password.")
    conn.close()
    st.stop()

# -----------------------------
# Admin login screen
# -----------------------------
if role == "admin" and not st.session_state.get("is_admin", False):
    st.subheader("Admin Login")
    admin_pass = st.text_input("Admin password", type="password")

    if st.button("Enter Admin"):
        real_admin = st.secrets.get("ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD)
        st.session_state["is_admin"] = (admin_pass == real_admin)
        if st.session_state["is_admin"]:
            st.success("Admin mode enabled.")
            st.rerun()
        else:
            st.error("Wrong admin password.")

    conn.close()
    st.stop()

# From here: logged in (team or admin)
is_admin = (role == "admin") and bool(st.session_state.get("is_admin", False))
team_logged_in = (role == "team") and (st.session_state.get("team_id") is not None)

# -----------------------------
# Tabs depend on role
# -----------------------------
if is_admin:
    tab_scoreboard, tab_admin = st.tabs(["📊 Scoreboard", "🛠️ Admin"])
elif team_logged_in:
    tab_scoreboard, tab_submit = st.tabs(["📊 Scoreboard", "✍️ Submit Answer"])
else:
    # safety fallback
    logout()
    st.rerun()

# -----------------------------
# Scoreboard (both roles)
# -----------------------------
with tab_scoreboard:
    gs = get_game_state(conn)

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
            [{"Team": s["team_name"], "Score": s["score"]} for s in scores],
            use_container_width=True,
            hide_index=True,
        )

    with colB:
        st.subheader("Game Status")
        st.write(f"**Round:** {gs['current_round']}")
        st.write(f"**Question:** {gs['current_question']}")
        st.write(f"**Half:** {gs['half']} (wagers: {allowed_wagers(int(gs['half']))})")
        st.write(f"**Submissions:** {'OPEN ✅' if gs['submissions_open'] else 'CLOSED ⛔'}")
        st.write(f"**Answer revealed:** {'YES ✅' if gs['revealed'] else 'NO'}")
        st.write(f"**New teams allowed:** {'YES ✅' if gs['allow_new_teams'] else 'NO ⛔'}")

    if team_logged_in:
        st.caption(f"Logged in as team: {st.session_state.get('team_name')}")
    if is_admin:
        st.caption("Logged in as Admin")

    if gs["revealed"] and gs["answer_text"].strip():
        st.divider()
        st.markdown(f"### ✅ Official Answer: {gs['answer_text']}")

# -----------------------------
# Submit Answer (teams only)
# -----------------------------
if team_logged_in:
    with tab_submit:
        st.subheader("Submit Your Answer")
        gs = get_game_state(conn)

        if not gs["submissions_open"]:
            st.warning("Submissions are currently closed.")
        else:
            st.write(f"**Round {gs['current_round']} — Question {gs['current_question']} (Half {gs['half']})**")
            if gs["question_text"].strip():
                st.markdown(f"### ❓ {gs['question_text']}")
            else:
                st.markdown("### ❓ (Host hasn’t posted the question text yet)")

            wager_opts = allowed_wagers(int(gs["half"]))
            answer_text = st.text_input("Your answer", key="team_answer")
            wager = st.selectbox("How many points are you wagering?", wager_opts, index=0, key="team_wager")

            if st.button("Submit / Update Answer"):
                if not answer_text.strip():
                    st.error("Answer can’t be empty.")
                else:
                    ok, msg = upsert_submission(conn, int(st.session_state["team_id"]), gs, answer_text.strip(), int(wager))
                    (st.success if ok else st.error)(msg)

        if gs["revealed"] and gs["answer_text"].strip():
            st.divider()
            st.markdown(f"### ✅ Official Answer: {gs['answer_text']}")

# -----------------------------
# Admin (admins only)
# -----------------------------
if is_admin:
    with tab_admin:
        st.subheader("Admin Controls")
        gs = get_game_state(conn)

        # --- Settings ---
        st.markdown("### Settings")
        allow = st.toggle("Allow new team creation", value=bool(gs["allow_new_teams"]))
        if st.button("Save Settings"):
            set_game_state(conn, allow_new_teams=1 if allow else 0)
            st.success("Settings saved.")
            st.rerun()

        st.divider()

        # --- Team Manager ---
        st.markdown("### Team Manager")
        teams = list_teams(conn)
        if not teams:
            st.info("No teams yet.")
        else:
            team_names = [t["team_name"] for t in teams]
            selected_name = st.selectbox("Select a team", team_names, key="admin_team_select")
            selected_team = next(t for t in teams if t["team_name"] == selected_name)

            st.write(f"**Team:** {selected_team['team_name']}")
            st.caption(f"Created: {selected_team['created_at']}")

            col_pw1, col_pw2 = st.columns(2)
            with col_pw1:
                new_pw = st.text_input("Set new password", type="password", key="admin_reset_pw")
                if st.button("Set Password"):
                    ok, msg = admin_set_team_password(conn, selected_team["id"], new_pw)
                    (st.success if ok else st.error)(msg)

            with col_pw2:
                if st.button("Generate Temp Password"):
                    temp_pw = generate_temp_password(8)
                    ok, msg = admin_set_team_password(conn, selected_team["id"], temp_pw)
                    if ok:
                        st.success(f"Temporary password for **{selected_team['team_name']}**: **{temp_pw}**")
                    else:
                        st.error(msg)

            cdel1, cdel2 = st.columns([1, 2])
            with cdel1:
                confirm_del = st.checkbox("Confirm delete", value=False, key="confirm_delete")
            with cdel2:
                if st.button("Delete Team (and submissions)"):
                    if not confirm_del:
                        st.error("Check 'Confirm delete' first.")
                    else:
                        admin_delete_team(conn, selected_team["id"])
                        st.success("Team deleted.")
                        st.rerun()

        st.divider()

        # --- Upload question bank CSV ---
        st.markdown("### Upload Question Bank (CSV)")
        st.caption("CSV header must be exactly: Number, Category, Question, Answer, Note")
        uploaded = st.file_uploader("Upload CSV", type=["csv"], key="qb_upload")
        if uploaded is not None:
            rows, errs = parse_question_csv(uploaded)
            if errs:
                st.error("CSV issues:")
                for e in errs[:20]:
                    st.write(f"- {e}")
            else:
                upsert_question_bank_rows(conn, rows)
                st.success(f"Loaded {len(rows)} questions (insert/update).")

        # --- Question index grouped by 3 ---
        st.divider()
        st.markdown("### Question Index (Number / Category)")
        idx = get_question_index(conn)
        if not idx:
            st.info("No questions loaded yet.")
        else:
            q_nums = [r["q_number"] for r in idx]
            min_q, max_q = min(q_nums), max(q_nums)
            start = min_q - ((min_q - 1) % 3)  # aligns to 1,4,7,...

            for block_start in range(start, max_q + 1, 3):
                block_end = block_start + 2
                block_rows = [r for r in idx if block_start <= r["q_number"] <= block_end]
                if not block_rows:
                    continue
                with st.container(border=True):
                    st.write(f"**{block_start}–{block_end}**")
                    for r in block_rows:
                        st.write(f"- {r['q_number']}: {r['category']}")

        st.divider()

        # --- Question setup ---
        st.markdown("### Question Setup")
        left, right = st.columns([2, 1])

        with right:
            st.markdown("#### Load from Bank")
            default_pick = int(gs["current_question"])
            pick = st.number_input("Question #", min_value=1, value=default_pick, step=1, key="pick_qnum")
            if st.button("Load into Live Game"):
                qrow = get_question_by_number(conn, int(pick))
                if not qrow:
                    st.error("That question number isn’t in the bank.")
                else:
                    q_text_live = f"[{qrow['category']}] {qrow['question']}"
                    set_game_state(conn, question_text=q_text_live, answer_text=qrow["answer"])
                    st.success("Loaded question/answer into live game.")
                    st.rerun()

        with left:
            gs = get_game_state(conn)
            q_text = st.text_area("Question text (what teams see)", value=gs["question_text"], height=110, key="q_text")
            a_text = st.text_input("Official answer (revealed when you choose)", value=gs["answer_text"], key="a_text")

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

        st.divider()

        # --- Progress game ---
        st.markdown("### Progress Game")
        gs = get_game_state(conn)
        col1, col2 = st.columns([2, 1])

        with col2:
            new_round = st.number_input("Round", min_value=1, value=int(gs["current_round"]), step=1, key="round_set")
            new_q = st.number_input("Question", min_value=1, value=int(gs["current_question"]), step=1, key="q_set")
            new_half = st.selectbox("Half", [1, 2], index=0 if int(gs["half"]) == 1 else 1, key="half_set")

            if st.button("Jump to (Round/Question/Half)"):
                set_game_state(
                    conn,
                    current_round=int(new_round),
                    current_question=int(new_q),
                    half=int(new_half),
                    submissions_open=0,
                    revealed=0
                )
                st.success("Game position updated (submissions closed, answer hidden).")
                st.rerun()

            if st.button("Next Question ➡️"):
                set_game_state(
                    conn,
                    current_question=int(gs["current_question"]) + 1,
                    submissions_open=0,
                    revealed=0
                )
                st.success("Advanced to next question.")
                st.rerun()

        with col1:
            st.markdown("### Grade Submissions (Current Question)")
            gs = get_game_state(conn)
            subs = fetch_submissions_for_current(conn, gs)

            if not subs:
                st.info("No submissions yet for the current question.")
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
                            b1, b2, b3 = st.columns(3)
                            with b1:
                                if st.button("Mark ✅", key=f"ok_{s['id']}"):
                                    grade_submission(conn, s["id"], correct=True, awarded_points=None)
                                    st.rerun()
                            with b2:
                                if st.button("Mark ❌", key=f"bad_{s['id']}"):
                                    grade_submission(conn, s["id"], correct=False, awarded_points=None)
                                    st.rerun()
                            with b3:
                                new_award = st.number_input(
                                    "Edit award",
                                    min_value=0,
                                    value=int(s["awarded_points"]),
                                    step=1,
                                    key=f"award_{s['id']}"
                                )
                                if st.button("Set", key=f"set_{s['id']}"):
                                    correct_guess = (s["is_correct"] == 1) if s["is_correct"] is not None else (new_award > 0)
                                    grade_submission(conn, s["id"], correct=bool(correct_guess), awarded_points=int(new_award))
                                    st.rerun()

conn.close()
