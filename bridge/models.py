from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TaskInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["mock", "deepseek"] = "deepseek"
    prompt: str = Field(min_length=1, max_length=24_000)
    mode: Literal["NEW_CHAT", "CONTINUE_CHAT"] = "NEW_CHAT"
    conversation_id: UUID | None = None

    @model_validator(mode="after")
    def check_conversation(self):
        if not self.prompt.strip():
            raise ValueError("Prompt must contain text")
        if (self.mode == "CONTINUE_CHAT") != (self.conversation_id is not None):
            raise ValueError("Only CONTINUE_CHAT requires a conversation ID")
        return self


class LeaseInput(BaseModel):
    lease: UUID


class Outcome(LeaseInput):
    status: Literal["succeeded", "failed", "paused", "uncertain", "retry", "cancelled"]
    answer: str | None = Field(default=None, max_length=150_000)
    markdown: str | None = Field(default=None, max_length=150_000)
    error: Literal[
        "tab_missing", "tab_closed", "login_required", "session_expired", "captcha",
        "usage_limited", "ui_changed", "input_unavailable", "send_unconfirmed",
        "generation_timeout", "generation_interrupted", "server_error",
        "conversation_changed", "provider_busy", "connection_lost",
    ] | None = None

    @model_validator(mode="after")
    def check_result(self):
        if self.status == "succeeded":
            if not self.answer or self.error:
                raise ValueError("Success requires an answer")
        elif self.status != "cancelled" and self.error is None:
            raise ValueError("This status requires an error code")
        return self


class BrowserState(BaseModel):
    protocol_version: Literal[1, 2] = 1
    state: Literal[
        "ready", "tab_missing", "login_required", "session_expired", "captcha",
        "usage_limited", "ui_changed", "provider_busy", "connection_lost",
    ]
