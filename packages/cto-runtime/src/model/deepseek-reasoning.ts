import type { CompatRule } from "@mastra/core/processors";
import { ProviderHistoryCompat } from "@mastra/core/processors";

const PROVIDER_PATTERN = /^deepseek($|[.-])/i;
const GATEWAY_PATTERN = /^deepseek[/:]/i;

/**
 * Mirrors Mastra's own provider matchers, because the model reaching a rule may
 * be an unresolved router id, a resolved language model, or a fallback list.
 */
function isDeepSeekModel(model: unknown): boolean {
  if (typeof model === "string") {
    return GATEWAY_PATTERN.test(model);
  }
  if (Array.isArray(model)) {
    return model.some((entry) =>
      isDeepSeekModel(
        entry !== null && typeof entry === "object" && "model" in entry
          ? entry.model
          : entry
      )
    );
  }
  if (model === null || typeof model !== "object") {
    return false;
  }
  if (
    "provider" in model &&
    typeof model.provider === "string" &&
    PROVIDER_PATTERN.test(model.provider)
  ) {
    return true;
  }
  return (
    "modelId" in model &&
    typeof model.modelId === "string" &&
    GATEWAY_PATTERN.test(model.modelId)
  );
}

/**
 * DeepSeek's thinking mode requires the `reasoning_content` field to be replayed
 * on every assistant message in every subsequent request. `@ai-sdk/deepseek`
 * only guarantees that field for model ids containing `deepseek-v4`: on any
 * other id it omits the field whenever a message has no reasoning part, and the
 * API rejects the next request with `The reasoning_content in the thinking mode
 * must be passed back to the API`.
 *
 * `deepseek-flash` is DeepSeek's moving alias for the latest V4 Flash model and
 * is served in thinking mode, so it needs the same guarantee. This rule supplies
 * it: every assistant message carries a reasoning part, which the adapter
 * serializes as `reasoning_content` — an empty string when the step produced no
 * reasoning, exactly as the adapter does for a versioned V4 id.
 *
 * The rule only adds a missing part. Reasoning the model did produce is replayed
 * untouched, because DeepSeek requires the original value back unchanged.
 *
 * Scope is deliberate. The adapter drops reasoning from assistant turns that
 * precede the last user message, so this rule cannot restore the field on
 * historical turns of a multi-turn thread; it covers the turn being continued,
 * which is the turn the API validates. Nothing is persisted: only the outbound
 * prompt is rewritten.
 */
export const deepseekReasoningEcho: CompatRule = {
  applyToPrompt({ model, prompt }) {
    if (!isDeepSeekModel(model)) {
      return;
    }
    let mutated = false;
    const next = prompt.map((message) => {
      if (message.role !== "assistant" || typeof message.content === "string") {
        return message;
      }
      if (message.content.some((part) => part.type === "reasoning")) {
        return message;
      }
      mutated = true;
      return {
        ...message,
        content: [{ text: "", type: "reasoning" as const }, ...message.content],
      };
    });
    return mutated ? next : undefined;
  },
  name: "deepseek-reasoning-echo",
};

/**
 * The provider-history compatibility processor for DeepSeek thinking models.
 *
 * Mastra's coding agent already installs `ProviderHistoryCompat` with its
 * built-in rules; this instance adds the DeepSeek rule alongside them, so it
 * must be passed as an input processor rather than replacing the agent's error
 * processors.
 */
export function deepseekReasoningCompat(): ProviderHistoryCompat {
  return new ProviderHistoryCompat({
    additionalRules: [deepseekReasoningEcho],
  });
}
