import sqlite3
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from bridge.main import create_app
from bridge.settings import Settings


@pytest.fixture
def bridge_api(tmp_path):
    def connect():
        client = TestClient(
            create_app(tmp_path / "queue.sqlite3", "test-token", Settings()),
            base_url="http://127.0.0.1:8765",
        )
        client.headers["Authorization"] = "Bearer test-token"
        return client

    return connect, tmp_path / "queue.sqlite3"


def create(client, **overrides):
    response = client.post(
        "/v1/tasks", json={"prompt": "Первая\nВторая", "provider": "mock", **overrides}
    )
    assert response.status_code == 201, response.text
    return response.json()


def claim(client, state="ready", **fields):
    response = client.post("/internal/claim", json={"state": state, **fields})
    assert response.status_code == 200, response.text
    return response.json()


def operation(client, task, name, **body):
    return client.post(
        f"/internal/tasks/{task['task_id']}/{name}",
        json={"lease": task["lease"], **body},
    )


def expire(db, task):
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE tasks SET lease_until=0 WHERE id=?", (task["task_id"],))


def test_recovery_preserves_queued_and_never_replays_running(bridge_api):
    connect, db = bridge_api
    with connect() as first:
        original = create(first)
        queued = create(first)
        leased = claim(first)
        assert leased["task_id"] == original["task_id"]
        assert claim(first) is None
    expire(db, leased)

    with connect() as second:
        retry = claim(second)
        assert retry["task_id"] == original["task_id"]
        assert retry["attempts"] == 2
        assert retry["lease"] != leased["lease"]
        assert operation(second, leased, "start").status_code == 404
        assert operation(second, retry, "start").json() == {"cancel_requested": False}
    expire(db, retry)

    with connect() as third:
        remaining = claim(third)
        assert remaining["task_id"] == queued["task_id"]
        result = third.get(f"/v1/tasks/{original['task_id']}/result").json()
        assert result["status"] == "uncertain"
        assert result["error"] == "connection_lost"
        assert operation(third, retry, "finish", status="succeeded", answer="late").status_code == 404


def test_pause_resume_and_cancel_in_flight(bridge_api):
    connect, _ = bridge_api
    with connect() as client:
        task = create(client)
        assert client.post("/v1/processing/pause", content=b"").status_code == 200
        assert claim(client) is None
        assert client.post("/v1/processing/resume", content=b"").status_code == 200
        leased = claim(client, "captcha")
        assert operation(client, leased, "finish", status="paused", error="captcha").json() == {
            "status": "paused"
        }
        assert claim(client) is None
        path = f"/v1/tasks/{task['task_id']}"
        assert client.post(path + "/resume", content=b"").json()["status"] == "queued"
        leased = claim(client)
        assert operation(client, leased, "start").status_code == 200
        client.post(path + "/cancel", content=b"").raise_for_status()
        assert operation(client, leased, "heartbeat").json()["cancel_requested"]
        assert operation(client, leased, "finish", status="succeeded", answer="late").json() == {
            "status": "cancelled"
        }
        assert client.get(path + "/result").json()["answer"] is None


def test_api_security_and_conversation_validation(bridge_api):
    connect, _ = bridge_api
    with connect() as client:
        assert client.get("/health").status_code == 200
        assert client.get("/v1/overview", headers={"Authorization": "Bearer invalid"}).status_code == 401
        assert client.get("/health", headers={"Host": "outside.example"}).status_code == 400
        assert client.post(
            "/v1/tasks", json={"prompt": "outside"}, headers={"Origin": "https://outside.example"}
        ).status_code == 403
        assert client.post("/v1/tasks", content=b" " * 150_001).status_code == 413
        assert client.post("/v1/tasks", json={"prompt": "x" * 24_001}).status_code == 422
        assert client.post("/v1/tasks", json={"prompt": "x", "provider": "deepseek"}).status_code == 403
        assert client.post("/v1/tasks", json={
            "prompt": "x", "provider": "mock", "mode": "CONTINUE_CHAT",
            "conversation_id": str(uuid4()),
        }).status_code == 409
        task = create(client, provider="mock")
        assert task["prompt"] == "Первая\nВторая"
        assert client.get(f"/v1/tasks/{task['task_id']}").json() == task


def test_waiting_queue_survives_a_long_pause(bridge_api):
    connect, db = bridge_api
    with connect() as client:
        client.post("/v1/processing/pause", content=b"").raise_for_status()
        task = create(client)
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE tasks SET created_at=1, available_at=1 WHERE id=?", (task["task_id"],))
    with connect() as client:
        assert claim(client) is None
        client.post("/v1/processing/resume", content=b"").raise_for_status()
        leased = claim(client)
        assert leased["task_id"] == task["task_id"]
        assert leased["timeout_ms"] > 170_000


def test_live_provider_configuration_controls_existing_and_new_tasks(tmp_path):
    path = tmp_path / "queue.sqlite3"

    def connect(enabled):
        return TestClient(
            create_app(path, "test-token", Settings(deepseek_browser_enabled=enabled)),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": "Bearer test-token"},
        )

    with connect(True) as client:
        live = create(client, provider="deepseek")
        mock = create(client, provider="mock")
    with connect(False) as client:
        assert claim(client, protocol_version=2)["task_id"] == mock["task_id"]
        assert client.get(f"/v1/tasks/{live['task_id']}").json()["status"] == "queued"
    with connect(True) as client:
        expire(path, mock)
        claimed = claim(client)
        assert claimed["task_id"] == mock["task_id"]
        expire(path, claimed)
        claimed = claim(client, protocol_version=2)
        assert claimed["task_id"] == live["task_id"]
        assert claimed["provider"] == "deepseek"


def test_deepseek_is_the_default_provider(tmp_path):
    client = TestClient(
        create_app(tmp_path / "queue.sqlite3", "test-token", Settings(deepseek_browser_enabled=True)),
        base_url="http://127.0.0.1:8765",
    )
    client.headers["Authorization"] = "Bearer test-token"
    with client:
        response = client.post("/v1/tasks", json={"prompt": "Без провайдера"})
        assert response.status_code == 201, response.text
        assert response.json()["provider"] == "deepseek"
