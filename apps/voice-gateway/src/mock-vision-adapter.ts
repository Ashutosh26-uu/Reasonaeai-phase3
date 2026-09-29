import type {
  StructuredIntent,
  SurfaceError,
} from "@reasonateai/contracts/intent";
import type { VisionAdapter } from "./vision-adapter.js";

export class MockVisionAdapter implements VisionAdapter {
  processImage(_imageFile: File): Promise<StructuredIntent | SurfaceError> {
    // MOCK IMPLEMENTATION
    return Promise.resolve({
      components: ["Data Table (Mock)", "Sidebar (Mock)"],
      inferredFeatures: ["Pagination (Mock)", "Filtering (Mock)"],
      screens: ["Dashboard (Mock)"],
      workflow: "User navigates to dashboard to view records (MOCK)",
    });
  }
}
