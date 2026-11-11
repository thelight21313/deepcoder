import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .api import router
from .database import Database
from .queue import Queue
from .settings import ROOT, Settings, load_settings, local_token, state_dir
from .worker import recover_queue


def create_app(db_path: Path | None = None, token: str | None = None, settings: Settings | None = None):
    queue = Queue(Database(db_path or state_dir() / "queue.sqlite3"), settings or load_settings())

    @asynccontextmanager
    async def lifespan(app):
        maintenance = asyncio.create_task(recover_queue(queue))
        try:
            yield
        finally:
            maintenance.cancel()
            with suppress(asyncio.CancelledError):
                await maintenance

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1"])

    @app.middleware("http")
    async def check_request(request, call_next):
        if request.method == "POST":
            if request.headers.get("origin") not in (None, "http://127.0.0.1:8765"):
                return JSONResponse({"detail": "Origin rejected"}, status_code=403)
            length = request.headers.get("content-length", "")
            if (request.headers.get("transfer-encoding") or not length.isascii()
                    or not length.isdecimal() or len(length) > 8):
                return JSONResponse({"detail": "Content-Length required"}, status_code=411)
            maximum = 150_000 if request.url.path == "/v1/tasks" else 2_000_000
            if int(length) > maximum:
                return JSONResponse({"detail": "Request too large"}, status_code=413)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        )
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return JSONResponse({"detail": "Invalid request"}, status_code=422)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    app.include_router(router(queue, token or local_token()))
    app.mount("/mock", StaticFiles(directory=ROOT / "mock-deepseek", html=True), name="mock")
    app.mount("/", StaticFiles(directory=ROOT / "dashboard", html=True), name="dashboard")
    return app


if __name__ == "__main__":
    uvicorn.run(create_app(), host="127.0.0.1", port=8765, access_log=False)
