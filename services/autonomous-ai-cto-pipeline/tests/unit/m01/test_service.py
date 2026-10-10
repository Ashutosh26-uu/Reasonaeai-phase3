import pytest

from modules.m01_sensory.normalizer import InputNormalizationError
from modules.m01_sensory.service import SensoryService
from modules.m01_sensory.whisper_transcriber import WhisperTranscriber


class FakeTranscriber:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def transcribe(self, audio_path, language=None):
        self.calls.append((audio_path, language))
        return self.result


def test_text_normalization():
    result = SensoryService().normalize_text("  Build\n\ta useful   API  ", source="console")

    assert result.input_type == "text"
    assert result.text == "Build a useful API"
    assert result.source == "console"
    assert result.confidence is None
    assert result.metadata == {}


def test_empty_text_is_rejected():
    with pytest.raises(InputNormalizationError, match="cannot be empty"):
        SensoryService().normalize_text(" \n\t ")


def test_normalized_voice_output():
    from modules.m01_sensory.models import TranscriptionResult

    transcriber = FakeTranscriber(
        TranscriptionResult(
            text="Create a dashboard",
            metadata={"model_name": "base", "language": "en"},
        )
    )
    audio_path = "tests/unit/m01/request.wav"
    result = SensoryService(transcriber=transcriber).normalize_audio(audio_path, language="en")

    assert result.input_type == "voice"
    assert result.text == "Create a dashboard"
    assert result.source == str(audio_path)
    assert result.metadata["language"] == "en"
    assert transcriber.calls == [(audio_path, "en")]


def test_invalid_audio_path_is_rejected_without_loading_whisper():
    transcriber = WhisperTranscriber()

    with pytest.raises(FileNotFoundError, match="Audio file not found"):
        transcriber.transcribe("tests/unit/m01/missing.wav")

    assert transcriber.is_model_loaded is False
