"""SSE keep-alive must catch asyncio.TimeoutError on Python 3.10 as well."""

import asyncio

from app.chat import streaming
from app.chat.streaming import EventJournal


def test_keepalive_then_event(monkeypatch):
    monkeypatch.setattr(streaming, "KEEPALIVE_SECONDS", 0.05)
    journal = EventJournal("conv-keepalive", "run-keepalive")

    async def scenario():
        reader = journal.read()
        assert await reader.__anext__() == ": keep-alive\n\n"

        journal.put_nowait(("delta", {"text": "hi"}))
        event = await reader.__anext__()
        assert event.startswith("event: delta\n")
        assert 'data: {"text": "hi"}' in event
        await reader.aclose()

    asyncio.run(scenario())