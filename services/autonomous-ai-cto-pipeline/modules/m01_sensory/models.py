"""Data models owned by M01."""

from typing import Any, Literal

from pydantic import BaseModel, Field


class NormalizedInput(BaseModel):
    """A validated, normalized input ready for a future downstream consumer."""

    input_type: Literal["text", "voice"]
    text: str
    source: str
    confidence: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TranscriptionResult(BaseModel):
    """Transcript and safe metadata returned by a local Whisper transcription."""

    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    confidence: float | None = None
