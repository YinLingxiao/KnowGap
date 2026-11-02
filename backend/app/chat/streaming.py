"""Resumable stream journals and the per-conversation outbox.

Readers own their cursors; closing a reader never owns or cancels the producer.
Journals live in memory: the reply text itself is saved to the message row while it
streams, so after a restart there is nothing left to resume. Queued prompts are
durable and stay outside the transcript until they actually start.
"""

import asyncio
import json
from collections import OrderedDict

from app.memory.store import new_id, now

MAX_QUEUED = 10
# Finished journals kept for readers that reconnect just after the reply ended.
KEEP_CLOSED = 32
STOPPED_REQUESTS = 256


def ensure(db):
    db.execute('''CREATE TABLE IF NOT EXISTS chat_outbox_state (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        paused INTEGER NOT NULL DEFAULT 0)''')
    db.execute('''CREATE TABLE IF NOT EXISTS chat_outbox (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        client_request_id TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', run_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, client_request_id))''')


class EventJournal:
    """Queue-compatible producer endpoint with independent, resumable readers."""

    def __init__(self, conversation_id: str, run_id: str):
        self.conversation_id = conversation_id
        self.run_id = run_id
        self.events: list[tuple[str, str]] = []
        self.closed = False
        self._changed = asyncio.Event()

    def put_nowait(self, item):
        if item is None:
            self.closed = True
        else:
            kind, data = item
            if kind == "start":
                self.closed = False  # A checkpoint resume opens a new segment of the same run.
            self.events.append((kind, json.dumps(data, ensure_ascii=False)))
        # Swap the event so every waiting reader wakes and none can clear it for another.
        changed, self._changed = self._changed, asyncio.Event()
        changed.set()

    async def read(self, after: int = 0):
        """SSE IDs are scoped to one run. Reconnecting does not replay model/tools."""
        starts = [seq for seq, (kind, _) in enumerate(self.events, 1) if kind == "start"]
        # Do not replay a previous segment's cancellation into a resumed view.
        cursor = max(after, starts[-1] - 1 if starts else 0)
        while True:
            changed = self._changed
            while cursor < len(self.events):
                kind, data = self.events[cursor]
                cursor += 1
                yield f"event: {kind}\ndata: {data}\nid: {self.run_id}:{cursor}\n\n"
            if self.closed:
                return
            try:
                await asyncio.wait_for(changed.wait(), timeout=15)
            except TimeoutError:
                yield ": keep-alive\n\n"


class StreamStore:
    def __init__(self, store):
        self.store = store
        self.journals: OrderedDict[str, EventJournal] = OrderedDict()
        # Stop pressed before a send was acknowledged: refuse that request if it arrives late.
        self.stopped: OrderedDict[tuple[str, str], None] = OrderedDict()

    def journal(self, conversation_id: str, run_id: str) -> EventJournal:
        journal = self.journals.get(run_id)
        if journal is None:
            journal = self.journals[run_id] = EventJournal(conversation_id, run_id)
        self.journals.move_to_end(run_id)
        closed = [key for key, item in self.journals.items() if item.closed]
        for key in closed[:-KEEP_CLOSED]:
            del self.journals[key]
        return journal

    def find_run(self, run_id: str, cid: str) -> EventJournal | None:
        journal = self.journals.get(run_id)
        return journal if journal and journal.conversation_id == cid else None

    def recover(self):
        # A process restart cannot resume provider tokens or safely replay tools.
        # Keep queued prompts, but require an explicit resume.
        with self.store.connection() as db:
            db.execute("INSERT INTO chat_outbox_state(conversation_id, paused) "
                       "SELECT DISTINCT conversation_id, 1 FROM chat_outbox WHERE status = 'pending' "
                       "ON CONFLICT(conversation_id) DO UPDATE SET paused = 1")

    def cancel_request(self, cid, request_id):
        self.stopped[(cid, request_id)] = None
        while len(self.stopped) > STOPPED_REQUESTS:
            self.stopped.popitem(last=False)

    def request_stopped(self, cid, request_id):
        return (cid, request_id) in self.stopped

    def pause(self, cid, paused=True):
        with self.store.connection() as db:
            db.execute("INSERT INTO chat_outbox_state SELECT id, ? FROM conversations WHERE id = ? "
                       "ON CONFLICT(conversation_id) DO UPDATE SET paused = excluded.paused", (int(paused), cid))

    def listing(self, cid):
        with self.store.connection() as db:
            state = db.execute("SELECT paused FROM chat_outbox_state WHERE conversation_id = ?", (cid,)).fetchone()
            items = db.execute("SELECT * FROM chat_outbox WHERE conversation_id = ? AND status = 'pending' "
                               "ORDER BY rowid", (cid,)).fetchall()
            return {"paused": bool(state and state[0]), "items": [dict(row) for row in items]}

    def item(self, item_id):
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM chat_outbox WHERE id = ?", (item_id,)).fetchone()
            return dict(row) if row else None

    def enqueue(self, cid, content, request_id):
        with self.store.connection() as db:
            existing = db.execute("SELECT * FROM chat_outbox WHERE conversation_id = ? AND client_request_id = ?", (cid, request_id)).fetchone()
            if not existing and db.execute("SELECT COUNT(*) FROM chat_outbox WHERE conversation_id = ? AND status = 'pending'",
                                           (cid,)).fetchone()[0] >= MAX_QUEUED:
                raise ValueError(f"最多暂存 {MAX_QUEUED} 条待发送消息，请先撤回或等待发送。")
            db.execute("INSERT OR IGNORE INTO chat_outbox(id, conversation_id, client_request_id, content, created_at) "
                       "VALUES (?, ?, ?, ?, ?)", (new_id("queued"), cid, request_id, content, now()))
            row = db.execute("SELECT * FROM chat_outbox WHERE conversation_id = ? AND client_request_id = ?",
                             (cid, request_id)).fetchone()
            if row["content"] != content:
                raise ValueError("相同发送编号对应的内容已变化，请重新发送。")
            return dict(row)

    def change(self, cid, item_id, content=None):
        with self.store.connection() as db:
            if content is None:
                cursor = db.execute("UPDATE chat_outbox SET status = 'cancelled' "
                                    "WHERE id = ? AND conversation_id = ? AND status = 'pending'", (item_id, cid))
            else:
                cursor = db.execute("UPDATE chat_outbox SET content = ? "
                                    "WHERE id = ? AND conversation_id = ? AND status = 'pending'", (content, item_id, cid))
            return cursor.rowcount > 0

    def dispatched(self, item_id, run_id):
        with self.store.connection() as db:
            db.execute("UPDATE chat_outbox SET status = 'dispatched', run_id = ? WHERE id = ?", (run_id, item_id))
