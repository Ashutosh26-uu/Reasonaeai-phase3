import type {
  EditableSpecification,
  SurfaceError,
} from "@reasonateai/contracts/intent";
import type { ASRAdapter } from "./asr-adapter.js";

export class MockASRAdapter implements ASRAdapter {
  processAudio(
    _audioBlob: Blob | File
  ): Promise<EditableSpecification | SurfaceError> {
    // MOCK IMPLEMENTATION
    return Promise.resolve({
      description: "Sample requirement generated from voice input (MOCK)",
      requirements: ["Requirement 1", "Requirement 2"],
      title: "Sample Application",
    });
  }
}
