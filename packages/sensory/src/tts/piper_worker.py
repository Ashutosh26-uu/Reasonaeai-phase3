from pathlib import Path
import json
import sys
import wave

from piper.voice import PiperVoice


def get_duration_ms(wav_path: str) -> int:
    """
    Calculate the duration of a generated WAV file in milliseconds.

    Piper writes standard WAV output, so duration can be calculated from
    the total number of audio frames and the sample rate.
    """
    with wave.open(wav_path, "rb") as wav:
        frames = wav.getnframes()
        sample_rate = wav.getframerate()

    if sample_rate <= 0:
        return 0

    return round((frames / sample_rate) * 1000)


def run(model_path: str, config_path: str | None = None) -> None:
    """
    Start the long-lived Piper worker.

    The Piper model is loaded once when the worker starts. Keeping the
    process alive avoids repeatedly loading the model for every synthesis
    request and reduces unnecessary inference startup overhead.
    """
    voice = PiperVoice.load(
        model_path=model_path,
        config_path=config_path,
    )

    # Process one JSON request per line until stdin is closed.
    #
    # A line-based protocol keeps communication between the TypeScript
    # application and Python inference process simple and predictable.
    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue

        request = None

        try:
            request = json.loads(line)

            request_id = request["id"]
            text = request["text"]
            output_path = request["output_path"]

            # Validate text before invoking the TTS model.
            if not isinstance(text, str) or not text.strip():
                raise ValueError("text must be a non-empty string")

            output = Path(output_path)
            output.parent.mkdir(parents=True, exist_ok=True)

            # Generate WAV audio directly through Piper's Python API.
            with wave.open(str(output), "wb") as wav_file:
                voice.synthesize_wav(
                    text=text,
                    wav_file=wav_file,
                )

            duration_ms = get_duration_ms(str(output))

            response = {
                "id": request_id,
                "ok": True,
                "output_path": str(output),
                "duration_ms": duration_ms,
            }

        except Exception as error:
            # Return a structured error instead of terminating the worker.
            # The request ID allows the TypeScript layer to associate the
            # error with the corresponding synthesis request.
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": str(error),
            }

        # Flush immediately so the TypeScript process receives the response
        # without waiting for Python stdout buffering.
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    # The first JSON message configures the persistent worker.
    #
    # The model is loaded once here and then reused for every subsequent
    # synthesis request.
    startup_request = json.loads(sys.stdin.readline())

    run(
        model_path=startup_request["model_path"],
        config_path=startup_request.get("config_path"),
    )
