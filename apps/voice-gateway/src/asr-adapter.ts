import type {
  EditableSpecification,
  SurfaceError,
} from "@reasonateai/contracts/intent";

export interface ASRAdapter {
  processAudio: (
    audioBlob: Blob | File
  ) => Promise<EditableSpecification | SurfaceError>;
}
