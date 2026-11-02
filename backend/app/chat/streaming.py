"""Durable stream journal and per-conversation outbox.

Readers own their cursors; closing a reader never owns or cancels the producer.
Queued prompts remain outside the transcript until they actually start.
"""

import asyncio
import json

from app.memory.store import new_id, now


class StreamStore:
    def __init__(self, store):
        self.store = store
        self.initialized = False

    def ensure(self):
        if self.initialized:
            return
        with self.store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS chat_stream_runs (
                    id TEXT PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    closed INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS chat_stream_events (
                    run_id TEXT NOT NULL REFERENCES chat_stream_runs(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
                    PRIMARY KEY(run_id, seq)
                );
                CREATE TABLE IF NOT EXISTS chat_outbox_state (
                    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
                    paused INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS chat_stopped_requests (
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    request_id TEXT NOT NULL, PRIMARY KEY(conversation_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS chat_outbox (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    client_request_id TEXT NOT NULL, content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending', run_id TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE(conversation_id, client_request_id)
                );
            """)
        self.initialized = True

    def recover(self):
        self.ensure()
        # A process restart cannot resume provider tokens or safely replay tools.
        # Keep the saved partial reply and require an explicit queue resume.
        with self.store.connection() as db:
            interrupted = db.execute("SELECT id FROM chat_stream_runs WHERE closed = 0").fetchall()
            partials = []
            for run in interrupted:
                text, reasoning = "", ""
                for event in db.execute("SELECT kind, data FROM chat_stream_events WHERE run_id = ? ORDER BY seq", (run["id"],)):
                    data = json.loads(event["data"])
                    if event["kind"] == "start":
                        message = data.get("assistant_message") or {}
                        text, reasoning = message.get("content", ""), message.get("reasoning", "")
                    elif event["kind"] == "delta":
                        text += data.get("text", "")
                    elif event["kind"] == "reasoning":
                        reasoning += data.get("text", "")
                partials.append((run["id"], text, reasoning))
            db.execute("UPDATE chat_stream_runs SET closed = 1")
            db.execute("INSERT INTO chat_outbox_state(conversation_id, paused) "
                       "SELECT DISTINCT conversation_id, 1 FROM chat_outbox WHERE status = 'pending' "
                       "ON CONFLICT(conversation_id) DO UPDATE SET paused = 1")
            # Completed transcripts remain; only old transport fragments expire.
            db.execute("DELETE FROM chat_stream_events WHERE run_id IN (SELECT r.id FROM chat_stream_runs r "
                       "JOIN conversation_messages m ON m.id = r.id WHERE r.closed = 1 AND m.updated_at < datetime('now', '-7 days'))")
            return partials

    def pause(self, cid, paused=True):
        self.ensure()
        with self.store.connection() as db:
            db.execute("INSERT INTO chat_outbox_state SELECT id, ? FROM conversations WHERE id = ? "
                       "ON CONFLICT(conversation_id) DO UPDATE SET paused = excluded.paused", (int(paused), cid))

    def cancel_request(self, cid, request_id):
        self.ensure()
        with self.store.connection() as db:
            db.execute("INSERT OR IGNORE INTO chat_stopped_requests VALUES (?, ?)", (cid, request_id))

    def request_stopped(self, cid, request_id):
        self.ensure()
        with self.store.connection() as db:
            return bool(db.execute("SELECT 1 FROM chat_stopped_requests WHERE conversation_id = ? AND request_id = ?", (cid, request_id)).fetchone())

    def listing(self, cid):
        self.ensure()
        with self.store.connection() as db:
            state = db.execute("SELECT paused FROM chat_outbox_state WHERE conversation_id = ?", (cid,)).fetchone()
            items = db.execute("SELECT * FROM chat_outbox WHERE conversation_id = ? AND status = 'pending' "
                               "ORDER BY rowid", (cid,)).fetchall()
            return {"paused": bool(state and state[0]), "items": [dict(row) for row in items]}

    def enqueue(self, cid, content, request_id):
        self.ensure()
        with self.store.connection() as db:
            existing = db.execute("SELECT * FROM chat_outbox WHERE conversation_id = ? AND client_request_id = ?", (cid, request_id)).fetchone()
            if not existing and db.execute("SELECT COUNT(*) FROM chat_outbox WHERE conversation_id = ? AND status = 'pending'", (cid,)).fetchone()[0] >= 10:
                raise ValueError("最多暂存 10 条待发送消息，请先撤回或等待发送。")
            db.execute("INSERT OR IGNORE INTO chat_outbox(id, conversation_id, client_request_id, content, created_at) "
                       "VALUES (?, ?, ?, ?, ?)", (new_id("queued"), cid, request_id, content, now()))
            row = db.execute("SELECT * FROM chat_outbox WHERE conversation_id = ? AND client_request_id = ?",
                             (cid, request_id)).fetchone()
            if row["content"] != content:
                raise ValueError("相同发送编号对应的内容已变化，请重新发送。")
            return dict(row)

    def change(self, cid, item_id, content=None):
        self.ensure()
        with self.store.connection() as db:
            if content is None:
                cursor = db.execute("UPDATE chat_outbox SET status = 'cancelled' "
                                    "WHERE id = ? AND conversation_id = ? AND status = 'pending'", (item_id, cid))
            else:
                cursor = db.execute("UPDATE chat_outbox SET content = ? "
                                    "WHERE id = ? AND conversation_id = ? AND status = 'pending'", (content, item_id, cid))
            return cursor.rowcount > 0

    def dispatched(self, item_id, run_id):
        self.ensure()
        with self.store.connection() as db:
            db.execute("UPDATE chat_outbox SET status = 'dispatched', run_id = ? WHERE id = ?", (run_id, item_id))

    def find_run(self, run_id, cid):
        self.ensure()
        with self.store.connection() as db:
            return db.execute("SELECT * FROM chat_stream_runs WHERE id = ? AND conversation_id = ?", (run_id, cid)).fetchone()


class EventJournal:
    """Queue-compatible producer endpoint, with independent resumable subscribers."""

    def __init__(self, streams, generation):
        streams.ensure()
        self.streams = streams
        self.run_id = generation.assistant_message_id
        self.changed = asyncio.Event()
        with streams.store.connection() as db:
            db.execute("INSERT INTO chat_stream_runs(id, conversation_id) VALUES (?, ?) "
                       "ON CONFLICT(id) DO UPDATE SET closed = 0", (self.run_id, generation.conversation_id))
            self.seq = db.execute("SELECT COALESCE(MAX(seq), 0) FROM chat_stream_events WHERE run_id = ?", (self.run_id,)).fetchone()[0]

    def put_nowait(self, item):
        with self.streams.store.connection() as db:
            if not db.execute("SELECT 1 FROM chat_stream_runs WHERE id = ?", (self.run_id,)).fetchone():
                self.changed.set()
                return  # The conversation may have been deleted while the worker was cancelling.
            if item is None:
                db.execute("UPDATE chat_stream_runs SET closed = 1 WHERE id = ?", (self.run_id,))
            else:
                self.seq += 1
                kind, data = item
                db.execute("INSERT INTO chat_stream_events VALUES (?, ?, ?, ?)",
                           (self.run_id, self.seq, kind, json.dumps(data, ensure_ascii=False)))
        self.changed.set()


async def read_events(streams, run_id, after=0, journal=None):
    """SSE IDs are scoped to one run. Reconnecting does not replay model/tools."""
    with streams.store.connection() as db:
        latest_start = db.execute("SELECT COALESCE(MAX(seq), 1) FROM chat_stream_events WHERE run_id = ? AND kind = 'start'", (run_id,)).fetchone()[0]
    # Checkpoint resume retains the assistant message, but starts a new stream segment.
    # Do not replay the previous attempt's cancellation into the resumed view.
    cursor = max(after, latest_start - 1)
    while True:
        if journal:
            journal.changed.clear()
        with streams.store.connection() as db:
            rows = db.execute("SELECT seq, kind, data FROM chat_stream_events WHERE run_id = ? AND seq > ? "
                              "ORDER BY seq LIMIT 200", (run_id, cursor)).fetchall()
            run = db.execute("SELECT closed FROM chat_stream_runs WHERE id = ?", (run_id,)).fetchone()
        for row in rows:
            cursor = row["seq"]
            yield f'event: {row["kind"]}\ndata: {row["data"]}\nid: {run_id}:{cursor}\n\n'
        if len(rows) == 200:
            continue
        if run is None or run["closed"]:
            return
        try:
            if journal:
                await asyncio.wait_for(journal.changed.wait(), timeout=15)
            else:
                await asyncio.sleep(0.3)
        except TimeoutError:
            yield ": keep-alive\n\n"
