import json
import sys

import whisper


def transcribe(audio_path: str, model_name: str = "base") -> dict:
    model = whisper.load_model(model_name)
    result = model.transcribe(audio_path)

    return {
        "text": result["text"].strip(),
        "language": result.get("language"),
        "confidence": None,
    }


if __name__ == "__main__":
    request = json.loads(sys.stdin.read())

    result = transcribe(
        audio_path=request["audio_path"],
        model_name=request.get("model", "base"),
    )

    print(json.dumps(result))
