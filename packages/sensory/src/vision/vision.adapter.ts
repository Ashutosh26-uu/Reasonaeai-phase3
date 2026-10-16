import type {
  VisionAdapter,
  VisionInput,
  VisionOutput,
} from "@reasonateai/contracts/sensory";

export interface VisionProvider {
  extract: (input: VisionInput) => Promise<VisionOutput>;
}

export const createVisionAdapter = (
  provider: VisionProvider
): VisionAdapter => ({
  extract: provider.extract,
});
