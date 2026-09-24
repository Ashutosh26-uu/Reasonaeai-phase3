import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TTSInput, TTSOutput } from "@reasonateai/contracts/sensory";
import type { TTSProvider } from "./index.js";

/**
 * Configuration required to start the persistent Piper worker.
 *
 * modelPath is the Piper .onnx voice model.
 * configPath is the optional Piper voice configuration file.
 * python allows callers to select a specific Python executable.
 * workerPath allows callers to override the bundled worker location.
 */
export interface PiperProviderOptions {
  configPath?: string;
  modelPath: string;
  python?: string;
  workerPath?: string;
}

/**
 * Response returned by the persistent Piper worker.
 *
 * The worker communicates with this TypeScript provider using
 * newline-delimited JSON (one JSON object per line).
 */
interface PiperWorkerResponse {
  duration_ms?: number;
  error?: string;
  id: string | null;
  ok: boolean;
  output_path?: string;
}

/**
 * A synthesis request waiting for a response from Piper.
 *
 * The request ID lets multiple synthesis calls share the same
 * persistent worker without mixing their responses.
 */
interface PendingRequest {
  id: string;
  reject: (error: Error) => void;
  resolve: (response: PiperWorkerResponse) => void;
}

/**
 * Create a replaceable Piper TTS provider.
 *
 * The Python Piper process is started lazily and kept alive.
 * This avoids loading the voice model for every synthesis request.
 */
export const createPiperProvider = (
  options: PiperProviderOptions
): TTSProvider & { close: () => void } => {
  const python = options.python ?? "python";

  /**
   * The worker is copied into dist/tts during the package build.
   */
  const workerPath =
    options.workerPath ??
    fileURLToPath(new URL("./piper_worker.py", import.meta.url));

  let child: ChildProcessWithoutNullStreams | null = null;
  let startupPromise: Promise<void> | null = null;

  /**
   * Requests that have been sent to Piper but have not received
   * a response yet.
   */
  const pending = new Map<string, PendingRequest>();

  /**
   * Node streams may split a JSON line across multiple chunks.
   * Keep incomplete data here until a complete line arrives.
   */
  let stdoutBuffer = "";

  /**
   * Resolve one complete response from the Piper worker.
   */
  const handleWorkerLine = (line: string): void => {
    if (!line.trim()) {
      return;
    }

    let response: PiperWorkerResponse;

    try {
      response = JSON.parse(line) as PiperWorkerResponse;
    } catch {
      /**
       * Ignore malformed worker output.
       */
      return;
    }

    if (!response.id) {
      return;
    }

    const request = pending.get(response.id);

    if (!request) {
      return;
    }

    pending.delete(response.id);

    if (!response.ok) {
      request.reject(new Error(response.error ?? "Piper synthesis failed"));
      return;
    }

    request.resolve(response);
  };

  /**
   * Start the persistent Piper Python worker.
   */
  const startWorker = (): Promise<void> => {
    if (child) {
      return Promise.resolve();
    }

    if (startupPromise) {
      return startupPromise;
    }

    startupPromise = new Promise<void>((resolve, reject) => {
      let settled = false;

      const currentChild = spawn(python, [workerPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      child = currentChild;

      /**
       * Read newline-delimited JSON responses from Piper.
       */
      currentChild.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();

        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          handleWorkerLine(line);
        }
      });

      /**
       * Handle a failure while starting the worker.
       */
      currentChild.on("error", (error) => {
        child = null;
        startupPromise = null;

        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      /**
       * Handle an unexpected worker exit.
       */
      currentChild.on("close", (code) => {
        child = null;
        startupPromise = null;

        const error = new Error(
          `Piper worker exited with code ${code ?? "unknown"}`
        );

        for (const request of pending.values()) {
          request.reject(error);
        }

        pending.clear();

        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      /**
       * Configure the worker.
       *
       * Piper loads the voice model once and reuses it for
       * subsequent synthesis requests.
       */
      currentChild.stdin.write(
        `${JSON.stringify({
          config_path: options.configPath ?? null,
          model_path: options.modelPath,
        })}\n`
      );

      /**
       * The process has started and received its configuration.
       */
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    return startupPromise;
  };

  /**
   * Synthesize text into WAV audio using the persistent worker.
   */
  const synthesize = async (input: TTSInput): Promise<TTSOutput> => {
    await startWorker();

    const currentChild = child;

    if (!currentChild) {
      throw new Error("Piper worker is not available");
    }

    /**
     * Give every request a unique ID and temporary output path.
     */
    const id = randomUUID();

    const outputPath = join("/tmp", `reasonateai-piper-${id}.wav`);

    const response = await new Promise<PiperWorkerResponse>(
      (resolve, reject) => {
        pending.set(id, {
          id,
          reject,
          resolve,
        });

        /**
         * Send one newline-delimited JSON request to Piper.
         */
        currentChild.stdin.write(
          `${JSON.stringify({
            id,
            output_path: outputPath,
            text: input.text,
          })}\n`
        );
      }
    );

    try {
      /**
       * Read the generated WAV file into memory.
       */
      const audio = new Uint8Array(await readFile(outputPath));

      return {
        audio,
        durationMs: response.duration_ms ?? null,
        mimeType: "audio/wav",
      };
    } finally {
      /**
       * Always remove the temporary WAV file.
       */
      await unlink(outputPath).catch(() => undefined);
    }
  };

  /**
   * Gracefully stop the persistent Piper worker.
   */
  const close = (): void => {
    if (!child) {
      return;
    }

    child.stdin.end();
    child.kill();

    child = null;
    startupPromise = null;
    stdoutBuffer = "";
  };

  return {
    close,
    synthesize,
  };
};
