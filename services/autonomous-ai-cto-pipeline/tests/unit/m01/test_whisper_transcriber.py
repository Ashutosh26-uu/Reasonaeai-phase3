from types import SimpleNamespace
from pathlib import Path

from modules.m01_sensory.whisper_transcriber import WhisperTranscriber


class FakeWhisperModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, audio_path, **options):
        self.calls.append((audio_path, options))
        return {"text": "  Hello from local Whisper.  ", "language": "en", "segments": [{}, {}]}


def test_voice_transcription_uses_mocked_whisper_model(monkeypatch):
    audio_path = "tests/unit/m01/test_whisper_transcriber.py"
    model = FakeWhisperModel()
    module = SimpleNamespace(load_model=lambda name: model)
    calls = []

    def fake_import(name):
        calls.append(name)
        return module

    monkeypatch.setattr("modules.m01_sensory.whisper_transcriber.importlib.import_module", fake_import)
    transcriber = WhisperTranscriber(model_name="tiny")

    result = transcriber.transcribe(audio_path, language="en")

    assert result.text == "Hello from local Whisper."
    assert result.metadata == {"model_name": "tiny", "language": "en", "segment_count": 2}
    assert calls == ["whisper"]
    assert model.calls == [(str(Path(audio_path)), {"language": "en"})]


def test_model_loading_is_lazy(monkeypatch):
    audio_path = "tests/unit/m01/test_whisper_transcriber.py"
    model = FakeWhisperModel()
    load_calls = []

    def load_model(name):
        load_calls.append(name)
        return model

    monkeypatch.setattr(
        "modules.m01_sensory.whisper_transcriber.importlib.import_module",
        lambda name: SimpleNamespace(load_model=load_model),
    )
    transcriber = WhisperTranscriber()

    assert transcriber.is_model_loaded is False
    assert load_calls == []

    transcriber.transcribe(audio_path)

    assert transcriber.is_model_loaded is True
    assert load_calls == ["base"]
