import type {
  ASRAdapter,
  ASRInput,
  ASROutput,
} from "@reasonateai/contracts/sensory";

// Provider contract used by the ASR adapter.
//
// A provider can be Whisper, faster-whisper, or another ASR implementation.
// Keeping this interface separate from the adapter allows the underlying
// speech-to-text model to be replaced without changing consumers of ASR.
export interface ASRProvider {
  transcribe: (input: ASRInput) => Promise<ASROutput>;
}

// Creates the application-facing ASR adapter.
//
// The adapter exposes the common ASRAdapter contract while delegating the
// actual transcription work to the selected provider. This keeps model-
// specific implementation details outside the rest of the application.
export const createASRAdapter = (provider: ASRProvider): ASRAdapter => ({
  transcribe: provider.transcribe,
});
