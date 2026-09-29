import type {
  StructuredIntent,
  SurfaceError,
} from "@reasonateai/contracts/intent";

export interface VisionAdapter {
  processImage: (imageFile: File) => Promise<StructuredIntent | SurfaceError>;
}
