import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    prompt TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    completed_at REAL,
    answer TEXT,
    markdown TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at REAL NOT NULL,
    deadline REAL NOT NULL,
    lease TEXT,
    lease_until REAL,
    cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS task_schedule ON tasks(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS task_conversation ON tasks(conversation_id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS single_lease ON tasks((1))
    WHERE status IN ('leased', 'running');
CREATE TABLE IF NOT EXISTS bridge_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    enabled INTEGER NOT NULL,
    browser_state TEXT,
    browser_seen REAL
);
INSERT OR IGNORE INTO bridge_state (singleton, enabled) VALUES (1, 1);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)

    @contextmanager
    def connect(self, *, write=False):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        try:
            if write:
                conn.execute("BEGIN IMMEDIATE")
            with conn:
                yield conn
        finally:
            conn.close()
