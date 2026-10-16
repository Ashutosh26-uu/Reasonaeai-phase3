import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createPiperProvider } from "../src/tts/piper.js";

const MODEL_PATH = "/kaggle/working/piper-voices/en_US-lessac-medium.onnx";

const CONFIG_PATH =
  "/kaggle/working/piper-voices/en_US-lessac-medium.onnx.json";

describe("Piper provider integration", () => {
  it("synthesizes speech using the persistent Piper worker", async () => {
    /**
     * Create the provider with the Piper model that we already verified
     * successfully in the Kaggle environment.
     */
    const provider = createPiperProvider({
      configPath: CONFIG_PATH,
      modelPath: MODEL_PATH,
    });

    try {
      /**
       * Send normal TTS input through the shared provider contract.
       */
      const result = await provider.synthesize({
        language: "en",
        text: "Hello from the ReasonateAI Piper text to speech provider.",
        voice: null,
      });

      /**
       * Verify the returned audio matches the shared TTS contract.
       */
      expect(result.mimeType).toBe("audio/wav");
      expect(result.audio.length).toBeGreaterThan(0);
      expect(result.durationMs).not.toBeNull();
      expect(result.durationMs ?? 0).toBeGreaterThan(0);

      /**
       * Save the returned bytes so we can listen to the exact audio
       * produced through the TypeScript adapter.
       */
      await writeFile("/kaggle/working/piper-provider-test.wav", result.audio);

      /**
       * Confirm that the generated file can be read back successfully.
       */
      const savedAudio = await readFile(
        "/kaggle/working/piper-provider-test.wav"
      );

      expect(savedAudio.length).toBeGreaterThan(0);

      console.log(
        `Generated ${savedAudio.length} bytes of WAV audio ` +
          `(${result.durationMs} ms).`
      );
    } finally {
      /**
       * Shut down the persistent Python worker after the test.
       */
      provider.close();
    }
  }, 30_000);
});
