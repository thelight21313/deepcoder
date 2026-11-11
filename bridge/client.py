import asyncio
from dataclasses import dataclass

import httpx

from .settings import local_token


@dataclass(frozen=True)
class Response:
    task_id: str
    conversation_id: str
    status: str
    answer: str | None
    markdown: str | None
    error: str | None


class Bridge:
    def __init__(self, token: str | None = None):
        self.token = token

    async def ask(
        self, *, provider: str, prompt: str, conversation_id: str | None = None,
        timeout: float = 200,
    ) -> Response:
        async with asyncio.timeout(timeout), httpx.AsyncClient(
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": "Bearer " + (self.token or local_token())},
            trust_env=False,
        ) as client:
            created = await client.post("/v1/tasks", json={
                "provider": provider, "prompt": prompt, "conversation_id": conversation_id,
                "mode": "CONTINUE_CHAT" if conversation_id else "NEW_CHAT",
            })
            created.raise_for_status()
            task_id = created.json()["task_id"]
            while True:
                result = await client.get(f"/v1/tasks/{task_id}/result")
                result.raise_for_status()
                response = Response(**result.json())
                if response.status not in {"queued", "leased", "running"}:
                    return response
                await asyncio.sleep(0.3)


bridge = Bridge()
