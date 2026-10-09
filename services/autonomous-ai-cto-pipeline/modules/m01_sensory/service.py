"""Simple application service for M01 text and voice inputs."""

from __future__ import annotations

from pathlib import Path

from modules.m01_sensory.models import NormalizedInput, TranscriptionResult
from modules.m01_sensory.normalizer import normalize_text_value
from modules.m01_sensory.whisper_transcriber import WhisperTranscriber


class SensoryService:
    """Independent entry point for normalizing text and local voice input."""

    def __init__(self, model_name: str = "base", transcriber: WhisperTranscriber | None = None) -> None:
        self.transcriber = transcriber or WhisperTranscriber(model_name=model_name)

    def normalize_text(self, text: str, source: str = "text") -> NormalizedInput:
        return NormalizedInput(
            input_type="text",
            text=normalize_text_value(text),
            source=source,
        )

    def transcribe_audio(self, audio_path: str | Path, language: str | None = None) -> TranscriptionResult:
        return self.transcriber.transcribe(audio_path, language=language)

    def normalize_audio(self, audio_path: str | Path, language: str | None = None) -> NormalizedInput:
        transcription = self.transcribe_audio(audio_path, language=language)
        return NormalizedInput(
            input_type="voice",
            text=transcription.text,
            source=str(audio_path),
            confidence=transcription.confidence,
            metadata=transcription.metadata,
        )


_default_service = SensoryService()


def normalize_text(text: str, source: str = "text") -> NormalizedInput:
    """Normalize text through the default M01 service."""

    return _default_service.normalize_text(text, source=source)


def transcribe_audio(audio_path: str | Path, language: str | None = None) -> TranscriptionResult:
    """Transcribe audio locally through the default M01 service."""

    return _default_service.transcribe_audio(audio_path, language=language)


def normalize_audio(audio_path: str | Path, language: str | None = None) -> NormalizedInput:
    """Transcribe and normalize audio through the default M01 service."""

    return _default_service.normalize_audio(audio_path, language=language)
