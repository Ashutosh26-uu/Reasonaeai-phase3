import type { MastraDBMessage } from "@mastra/core/agent-controller";

/**
 * The text a message carries: every text part, concatenated in order.
 *
 * One definition for both run mappers. The durable ledger records a message
 * once it is complete and the live channel records the same message as it
 * grows, so a second reading of "what text does this message carry" would let
 * the two disagree about one message — the ledger would hold text the live view
 * never produced, or the reverse.
 *
 * The model's own parts are not text a person is meant to read, so only `text`
 * parts contribute: a tool call, a file, or a reasoning signature is not the
 * message's prose.
 */
export function messageText(message: Pick<MastraDBMessage, "content">): string {
  let text = "";
  for (const part of message.content.parts) {
    if (part.type === "text") {
      text += part.text;
    }
  }
  return text;
}
