import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ASRInput, ASROutput } from "@reasonateai/contracts/sensory";
import type { ASRProvider } from "./index.js";

// Configuration for the OpenAI Whisper provider.
//
// Keeping these values configurable allows the Whisper model, Python runtime,
// and worker location to change without modifying the ASR adapter itself.
export interface WhisperProviderOptions {
  model?: string;
  python?: string;
  workerPath?: string;
}

// JSON returned by the Python Whisper worker.
interface WhisperWorkerOutput {
  confidence: number | null;
  language: string | null;
  text: string;
}

// Creates an ASR provider backed by OpenAI Whisper.
//
// The TypeScript application does not import the Python Whisper package
// directly. Instead, it communicates with a small Python worker process.
// This keeps the provider boundary replaceable and isolates Python-specific
// Whisper implementation details from the rest of the application.
export const createWhisperProvider = (
  options: WhisperProviderOptions = {}
): ASRProvider => {
  // Use the system Python executable unless another executable is configured.
  const python = options.python ?? "python";

  // "base" is a practical default for development/testing.
  // The model can be changed later without changing the provider API.
  const model = options.model ?? "base";

  // Locate the Python worker next to this TypeScript provider by default.
  const workerPath =
    options.workerPath ??
    new URL("./whisper_worker.py", import.meta.url).pathname;

  return {
    // Transcribes audio using the configured Whisper worker.
    async transcribe(input: ASRInput): Promise<ASROutput> {
      // The Python worker expects an audio file, so temporarily write the
      // incoming Uint8Array to disk before starting the worker process.
      const extension = input.mimeType.split("/")[1] ?? "bin";
      const audioPath = join(
        "/tmp",
        `reasonateai-whisper-${randomUUID()}.${extension}`
      );

      await writeFile(audioPath, input.audio);

      try {
        // Send only the information required by the Python worker.
        const request = JSON.stringify({
          audio_path: audioPath,
          model,
        });

        // Run the Python Whisper worker and collect its JSON response.
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(python, [workerPath], {
            stdio: ["pipe", "pipe", "pipe"],
          });

          let stdout = "";
          let stderr = "";

          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });

          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          child.on("error", reject);

          child.on("close", (code) => {
            if (code === 0) {
              resolve(stdout);
              return;
            }

            reject(
              new Error(
                `Whisper worker failed with exit code ${code}: ${
                  stderr.trim() || "unknown error"
                }`
              )
            );
          });

          // Pass the transcription request to the Python worker through stdin.
          child.stdin.write(request);
          child.stdin.end();
        });

        // Convert the worker's JSON response into the common ASR output
        // contract used by the rest of the application.
        const result = JSON.parse(output) as WhisperWorkerOutput;

        return {
          confidence: result.confidence,
          language: result.language,
          text: result.text,
        };
      } finally {
        // Always remove the temporary audio file, including when Whisper
        // fails, so user audio is not unnecessarily left on disk.
        await unlink(audioPath).catch(() => undefined);
      }
    },
  };
};
