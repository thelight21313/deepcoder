import time
from uuid import uuid4

from .database import Database
from .models import Outcome, TaskInput
from .settings import Settings

PUBLIC_COLUMNS = """
    id AS task_id, conversation_id, provider, prompt, mode, status,
    created_at, completed_at, answer, markdown, error, attempts, cancel_requested
"""


class Queue:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings

    def create(self, task: TaskInput):
        task_id = str(uuid4())
        conversation = str(task.conversation_id or uuid4())
        now = time.time()
        with self.db.connect(write=True) as conn:
            if task.conversation_id and not conn.execute(
                """SELECT 1 FROM tasks WHERE conversation_id=? AND provider=?
                AND mode='NEW_CHAT' AND status='succeeded'""",
                (conversation, task.provider),
            ).fetchone():
                raise LookupError("Unknown conversation")
            conn.execute(
                """INSERT INTO tasks (id, conversation_id, provider, prompt, mode,
                status, created_at, available_at, deadline)
                VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0)""",
                (task_id, conversation, task.provider, task.prompt, task.mode,
                 now, now),
            )
            return self._get(conn, task_id)

    @staticmethod
    def _get(conn, task_id):
        row = conn.execute(
            f"SELECT {PUBLIC_COLUMNS} FROM tasks WHERE id=?", (task_id,)
        ).fetchone()
        return dict(row) if row else None

    def get(self, task_id):
        with self.db.connect() as conn:
            return self._get(conn, task_id)

    def _recover(self, conn, now):
        conn.execute(
            """UPDATE tasks SET status='queued', lease=NULL, lease_until=NULL,
            available_at=?, error='connection_lost' WHERE status='leased'
            AND cancel_requested=0 AND lease_until<=? AND deadline>? AND attempts<?""",
            (now, now, now, self.settings.max_attempts),
        )
        conn.execute(
            """UPDATE tasks SET status=CASE
                WHEN cancel_requested=1 THEN 'cancelled'
                WHEN status='running' THEN 'uncertain' ELSE 'failed' END,
                error=CASE
                WHEN cancel_requested=1 THEN NULL
                WHEN deadline<=? THEN 'task_timeout' ELSE 'connection_lost' END,
                completed_at=?, lease=NULL, lease_until=NULL
            WHERE (status='queued' AND deadline>0 AND deadline<=?) OR
                (status IN ('leased','running') AND (lease_until<=? OR deadline<=?))""",
            (now, now, now, now, now),
        )

    def recover(self):
        with self.db.connect(write=True) as conn:
            self._recover(conn, time.time())

    def claim(self, browser_state, *, protocol_version):
        now = time.time()
        with self.db.connect(write=True) as conn:
            self._recover(conn, now)
            conn.execute(
                "UPDATE bridge_state SET browser_state=?, browser_seen=?",
                (browser_state, now),
            )
            enabled = conn.execute("SELECT enabled FROM bridge_state").fetchone()[0]
            if not enabled or conn.execute(
                "SELECT 1 FROM tasks WHERE status IN ('leased','running')"
            ).fetchone():
                return None
            row = conn.execute(
                """SELECT id, deadline FROM tasks WHERE status='queued'
                AND available_at<=? AND (provider='mock' OR ?)
                ORDER BY created_at, id LIMIT 1""",
                (now, self.settings.deepseek_browser_enabled and protocol_version >= 2),
            ).fetchone()
            if row is None:
                return None
            lease = str(uuid4())
            deadline = row["deadline"] or now + self.settings.task_timeout
            conn.execute(
                """UPDATE tasks SET status='leased', lease=?, lease_until=?, deadline=?,
                attempts=attempts+1, error=NULL WHERE id=?""",
                (lease, now + self.settings.lease_timeout, deadline, row["id"]),
            )
            return {
                **self._get(conn, row["id"]),
                "lease": lease,
                "timeout_ms": int((deadline - now) * 1000),
            }

    def heartbeat(self, task_id, lease, *, start=False):
        now = time.time()
        with self.db.connect(write=True) as conn:
            self._recover(conn, now)
            conn.execute("UPDATE bridge_state SET browser_seen=?", (now,))
            row = conn.execute(
                "SELECT status, cancel_requested FROM tasks WHERE id=? AND lease=?",
                (task_id, lease),
            ).fetchone()
            if not row or (start and row["status"] != "leased"):
                return None
            status = "running" if start and not row["cancel_requested"] else row["status"]
            conn.execute(
                "UPDATE tasks SET status=?, lease_until=? WHERE id=?",
                (status, now + self.settings.lease_timeout, task_id),
            )
            return {"cancel_requested": bool(row["cancel_requested"])}

    def finish(self, task_id, outcome: Outcome):
        now = time.time()
        with self.db.connect(write=True) as conn:
            self._recover(conn, now)
            row = conn.execute(
                """SELECT status, attempts, cancel_requested, deadline FROM tasks
                WHERE id=? AND lease=?""", (task_id, str(outcome.lease))
            ).fetchone()
            if row is None:
                return None
            status, error = outcome.status, outcome.error
            answer, markdown = outcome.answer, outcome.markdown
            available_at, completed_at = now, now
            if row["cancel_requested"]:
                status, error, answer, markdown = "cancelled", None, None, None
            elif status == "retry":
                if row["status"] != "leased":
                    status = "uncertain"
                elif row["attempts"] < self.settings.max_attempts:
                    available_at = now + 2 ** (row["attempts"] - 1)
                    status = "queued" if available_at < row["deadline"] else "failed"
                else:
                    status = "failed"
            elif status == "paused" and row["status"] == "running":
                status = "uncertain"
            elif status == "succeeded" and row["status"] != "running":
                raise ValueError("Task must be running before it can succeed")
            if status in ("queued", "paused"):
                completed_at = None
            conn.execute(
                """UPDATE tasks SET status=?, answer=?, markdown=?, error=?, completed_at=?,
                lease=NULL, lease_until=NULL, available_at=? WHERE id=?""",
                (status, answer, markdown, error, completed_at, available_at, task_id),
            )
            return self._get(conn, task_id)

    def cancel(self, task_id):
        with self.db.connect(write=True) as conn:
            conn.execute(
                """UPDATE tasks SET cancel_requested=1,
                status=CASE WHEN status IN ('queued','paused') THEN 'cancelled' ELSE status END,
                completed_at=CASE WHEN status IN ('queued','paused') THEN ? ELSE completed_at END,
                error=CASE WHEN status IN ('queued','paused') THEN NULL ELSE error END
                WHERE id=? AND status IN ('queued','leased','running','paused')""",
                (time.time(), task_id),
            )
            return self._get(conn, task_id)

    def resume(self, task_id):
        now = time.time()
        with self.db.connect(write=True) as conn:
            conn.execute(
                """UPDATE tasks SET status='queued', attempts=0, available_at=?, deadline=0,
                error=NULL WHERE id=? AND status='paused'""",
                (now, task_id),
            )
            return self._get(conn, task_id)

    def set_enabled(self, enabled):
        with self.db.connect(write=True) as conn:
            conn.execute("UPDATE bridge_state SET enabled=?", (int(enabled),))

    def overview(self, limit):
        now = time.time()
        with self.db.connect() as conn:
            state = conn.execute("SELECT * FROM bridge_state").fetchone()
            tasks = conn.execute(
                f"SELECT {PUBLIC_COLUMNS} FROM tasks ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            queued = conn.execute("SELECT count(*) FROM tasks WHERE status='queued'").fetchone()[0]
            active = conn.execute(
                "SELECT id FROM tasks WHERE status IN ('leased','running')"
            ).fetchone()
        connected = state["browser_seen"] is not None and (
            now - state["browser_seen"] < self.settings.lease_timeout
        )
        return {
            "enabled": bool(state["enabled"]), "browser_connected": connected,
            "browser_state": state["browser_state"] if connected else "disconnected",
            "active_task": active[0] if active else None, "queue_length": queued,
            "tasks": [dict(row) for row in tasks],
        }
