"""
src/database.py — SQLite layer for mod_logs and invite_logs.
Thread-safe. Auto-initialises tables on import.
"""
import json
import logging
import os
import sqlite3
import threading

from src.config import DB_PATH

log   = logging.getLogger(__name__)
_lock = threading.Lock()


# ── Connection ────────────────────────────────────────────────────────────────

def _conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")  # 64MB cache
    return conn


# ── Schema ────────────────────────────────────────────────────────────────────

def init_db() -> None:
    with _lock:
        conn = _conn()
        try:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS mod_logs (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                server    TEXT    NOT NULL,
                user      TEXT    NOT NULL,
                channel   TEXT    NOT NULL,
                action    TEXT    NOT NULL,
                details   TEXT,
                timestamp TEXT    NOT NULL
            );

            CREATE TABLE IF NOT EXISTS invite_logs (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type     TEXT    NOT NULL,
                member         TEXT    NOT NULL,
                discord_id     TEXT    NOT NULL,
                inviter        TEXT,
                invite_code    TEXT,
                max_uses       INTEGER DEFAULT 0,
                uses           INTEGER DEFAULT 0,
                expires_at     TEXT,
                is_temporary   INTEGER DEFAULT 0,
                timestamp      TEXT    NOT NULL,
                server         TEXT,
                inviter_role   TEXT,
                source         TEXT,
                join_method    TEXT,
                notes          TEXT,
                invite_created TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_mod_timestamp    ON mod_logs    (timestamp);
            CREATE INDEX IF NOT EXISTS idx_mod_action       ON mod_logs    (action);
            CREATE INDEX IF NOT EXISTS idx_invite_timestamp ON invite_logs (timestamp);
            CREATE INDEX IF NOT EXISTS idx_invite_member    ON invite_logs (discord_id);
            CREATE INDEX IF NOT EXISTS idx_invite_type      ON invite_logs (event_type);
            """)
            conn.commit()
            log.debug("DB initialised at %s", DB_PATH)
        finally:
            conn.close()


# ── Mod logs ──────────────────────────────────────────────────────────────────

def insert_mod_log(
    server: str, user: str, channel: str,
    action: str, details: list, timestamp: str,
) -> None:
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO mod_logs(server,user,channel,action,details,timestamp) VALUES(?,?,?,?,?,?)",
                (server, user, channel, action, json.dumps(details, ensure_ascii=False), timestamp),
            )
            conn.commit()
        finally:
            conn.close()


def delete_mod_logs() -> None:
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM mod_logs")
            conn.commit()
        finally:
            conn.close()


def get_mod_logs(limit: int = 500) -> list[dict]:
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT * FROM mod_logs ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        finally:
            conn.close()

    result = []
    for r in rows:
        d = dict(r)
        # details is already a list (stored as JSON string in DB)
        raw = d.get("details")
        if isinstance(raw, str):
            try:
                d["details"] = json.loads(raw)
            except Exception:
                d["details"] = []
        elif not isinstance(raw, list):
            d["details"] = []
        result.append(d)
    return result


# ── Invite logs ───────────────────────────────────────────────────────────────

def insert_invite_log(
    *, event_type: str, member: str, discord_id: str,
    inviter: str, invite_code: str, max_uses: int, uses: int,
    expires_at: str, is_temporary: bool, timestamp: str,
    server: str, inviter_role: str, source: str,
    join_method: str, notes: str, invite_created: str,
) -> None:
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                """INSERT INTO invite_logs
                   (event_type,member,discord_id,inviter,invite_code,max_uses,uses,
                    expires_at,is_temporary,timestamp,server,inviter_role,source,
                    join_method,notes,invite_created)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (event_type, member, discord_id, inviter, invite_code, max_uses, uses,
                 expires_at, 1 if is_temporary else 0, timestamp, server, inviter_role,
                 source, join_method, notes, invite_created),
            )
            conn.commit()
        finally:
            conn.close()


def delete_invite_logs() -> None:
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM invite_logs")
            conn.commit()
        finally:
            conn.close()


def get_invite_logs(limit: int = 500) -> list[dict]:
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT * FROM invite_logs ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        finally:
            conn.close()
    return [dict(r) for r in rows]


# Auto-init on import
init_db()
