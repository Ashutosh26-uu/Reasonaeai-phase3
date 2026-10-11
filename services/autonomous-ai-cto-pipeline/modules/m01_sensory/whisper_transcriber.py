"""Lazy local adapter for the open-source openai-whisper package."""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any

from modules.m01_sensory.models import TranscriptionResult
from modules.m01_sensory.normalizer import InputNormalizationError, normalize_text_value


class WhisperDependencyError(RuntimeError):
    """Raised when local Whisper is not installed."""


class WhisperTranscriptionError(RuntimeError):
    """Raised when local Whisper cannot transcribe an audio file."""


class WhisperTranscriber:
    """Transcribe audio locally, loading the Whisper model only when needed."""

    def __init__(self, model_name: str = "base") -> None:
        self.model_name = model_name
        self._model: Any | None = None

    @property
    def is_model_loaded(self) -> bool:
        """Whether this transcriber has loaded its local Whisper model."""

        return self._model is not None

    def transcribe(self, audio_path: str | Path, language: str | None = None) -> TranscriptionResult:
        """Return a local Whisper transcript and non-sensitive result metadata."""

        path = Path(audio_path)
        if not path.is_file():
            raise FileNotFoundError(f"Audio file not found: {path}")

        options: dict[str, Any] = {}
        if language is not None:
            options["language"] = language

        try:
            result = self._get_model().transcribe(str(path), **options)
        except WhisperDependencyError:
            raise
        except Exception as exc:
            raise WhisperTranscriptionError("Local Whisper transcription failed.") from exc

        if not isinstance(result, dict) or not isinstance(result.get("text"), str):
            raise WhisperTranscriptionError("Local Whisper returned an invalid transcription result.")

        try:
            transcript = normalize_text_value(result["text"])
        except InputNormalizationError as exc:
            raise WhisperTranscriptionError("Local Whisper returned an empty transcript.") from exc

        metadata: dict[str, Any] = {
            "model_name": self.model_name,
            "language": result.get("language", language),
        }
        segments = result.get("segments")
        if isinstance(segments, list):
            metadata["segment_count"] = len(segments)

        return TranscriptionResult(text=transcript, metadata=metadata)

    def _get_model(self) -> Any:
        if self._model is not None:
            return self._model

        try:
            whisper = importlib.import_module("whisper")
        except ImportError as exc:
            raise WhisperDependencyError(
                "Local Whisper is unavailable. Install the 'openai-whisper' package to enable voice input."
            ) from exc

        try:
            self._model = whisper.load_model(self.model_name)
        except Exception as exc:
            raise WhisperTranscriptionError("Unable to load the local Whisper model.") from exc
        return self._model
