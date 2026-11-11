import hmac
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from .models import BrowserState, LeaseInput, Outcome, TaskInput
from .queue import Queue

logger = logging.getLogger("uvicorn.error")


def router(queue: Queue, token: str):
    def authenticate(authorization: Annotated[str | None, Header()] = None):
        supplied = (authorization or "").encode()
        if not hmac.compare_digest(supplied, b"Bearer " + token.encode()):
            raise HTTPException(401, "Invalid Bridge token", headers={"WWW-Authenticate": "Bearer"})

    api = APIRouter(dependencies=[Depends(authenticate)])

    def existing(task):
        if task is None:
            raise HTTPException(404, "Task not found")
        return task

    @api.post("/v1/tasks", status_code=201)
    def create(task: TaskInput):
        if task.provider == "deepseek" and not queue.settings.deepseek_browser_enabled:
            raise HTTPException(403, "Real DeepSeek browser integration is disabled")
        try:
            created = queue.create(task)
            logger.info("Task %s queued", created["task_id"])
            return created
        except LookupError as exc:
            raise HTTPException(409, str(exc)) from exc

    @api.get("/v1/tasks/{task_id}")
    def status(task_id: UUID):
        return existing(queue.get(str(task_id)))

    @api.get("/v1/tasks/{task_id}/result")
    def result(task_id: UUID):
        task = existing(queue.get(str(task_id)))
        return {key: task[key] for key in (
            "task_id", "conversation_id", "status", "answer", "markdown", "error"
        )}

    @api.post("/v1/tasks/{task_id}/cancel")
    def cancel(task_id: UUID):
        return existing(queue.cancel(str(task_id)))

    @api.post("/v1/tasks/{task_id}/resume")
    def resume(task_id: UUID):
        return existing(queue.resume(str(task_id)))

    @api.get("/v1/overview")
    def overview(limit: int = Query(30, ge=0, le=100)):
        return queue.overview(limit)

    @api.post("/v1/processing/{action}")
    def processing(action: str):
        if action not in ("start", "pause", "resume"):
            raise HTTPException(404, "Unknown action")
        queue.set_enabled(action != "pause")
        return {"enabled": action != "pause"}

    @api.post("/internal/claim")
    def claim(browser: BrowserState):
        return queue.claim(browser.state, protocol_version=browser.protocol_version)

    @api.post("/internal/tasks/{task_id}/start")
    def start(task_id: UUID, body: LeaseInput):
        return existing(queue.heartbeat(str(task_id), str(body.lease), start=True))

    @api.post("/internal/tasks/{task_id}/heartbeat")
    def heartbeat(task_id: UUID, body: LeaseInput):
        return existing(queue.heartbeat(str(task_id), str(body.lease)))

    @api.post("/internal/tasks/{task_id}/finish")
    def finish(task_id: UUID, body: Outcome):
        try:
            task = existing(queue.finish(str(task_id), body))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        logger.info("Task %s moved to %s (%s)", task_id, task["status"], task["error"])
        return {"status": task["status"]}

    return api
