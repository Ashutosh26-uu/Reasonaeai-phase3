import type {
  TTSAdapter,
  TTSInput,
  TTSOutput,
} from "@reasonateai/contracts/sensory";

export interface TTSProvider {
  synthesize: (input: TTSInput) => Promise<TTSOutput>;
}

export const createTTSAdapter = (provider: TTSProvider): TTSAdapter => ({
  synthesize: provider.synthesize,
});
