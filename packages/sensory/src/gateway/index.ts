import type {
  ASRAdapter,
  ASRInput,
  ASROutput,
  TTSAdapter,
  TTSInput,
  TTSOutput,
  VisionAdapter,
  VisionInput,
  VisionOutput,
} from "@reasonateai/contracts/sensory";

export interface SensoryGatewayOptions {
  asr: ASRAdapter;
  timeoutMs?: number;
  tts: TTSAdapter;
  vision: VisionAdapter;
}

export interface SensoryGateway {
  close: () => void;
  extract: (input: VisionInput) => Promise<VisionOutput>;
  synthesize: (input: TTSInput) => Promise<TTSOutput>;
  transcribe: (input: ASRInput) => Promise<ASROutput>;
}

export type SensoryOperation = "asr" | "tts" | "vision";

export class SensoryGatewayError extends Error {
  readonly operation: SensoryOperation;

  constructor(operation: SensoryOperation, message: string) {
    super(message);
    this.name = "SensoryGatewayError";
    this.operation = operation;
  }
}

const createGatewayError = (
  operation: SensoryOperation,
  message: string,
  cause: unknown
): SensoryGatewayError => {
  const gatewayError = new SensoryGatewayError(operation, message);

  Object.defineProperty(gatewayError, "cause", {
    configurable: true,
    enumerable: false,
    value: cause,
    writable: true,
  });

  return gatewayError;
};

interface Closable {
  close: () => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
};

const validateTimeout = (timeoutMs: number): void => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Sensory gateway timeout must be a positive finite number");
  }
};

export const createSensoryGateway = (
  options: SensoryGatewayOptions
): SensoryGateway => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  validateTimeout(timeoutMs);

  const transcribe = async (input: ASRInput): Promise<ASROutput> => {
    try {
      return await withTimeout(
        options.asr.transcribe(input),
        timeoutMs,
        "ASR transcription"
      );
    } catch (error) {
      // Preserve the original provider error as the native Error cause.
      throw createGatewayError("asr", "ASR transcription failed", error);
    }
  };

  const synthesize = async (input: TTSInput): Promise<TTSOutput> => {
    try {
      return await withTimeout(
        options.tts.synthesize(input),
        timeoutMs,
        "TTS synthesis"
      );
    } catch (error) {
      // Preserve the original provider error as the native Error cause.
      throw createGatewayError("tts", "TTS synthesis failed", error);
    }
  };

  const extract = async (input: VisionInput): Promise<VisionOutput> => {
    try {
      return await withTimeout(
        options.vision.extract(input),
        timeoutMs,
        "Vision extraction"
      );
    } catch (error) {
      // Preserve the original provider error as the native Error cause.
      throw createGatewayError("vision", "Vision extraction failed", error);
    }
  };

  const close = (): void => {
    const providers: unknown[] = [options.asr, options.tts, options.vision];

    for (const provider of providers) {
      const closable = provider as Partial<Closable>;

      if (typeof closable.close === "function") {
        closable.close();
      }
    }
  };

  return {
    close,
    extract,
    synthesize,
    transcribe,
  };
};
