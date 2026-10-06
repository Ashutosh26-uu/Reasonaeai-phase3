import type { TranscriptTurn } from "./timeline";

export interface MessageNavigationItem {
  id: string;
  title: string;
}

export const messageAnchor = (id: string) =>
  `chat-message-${encodeURIComponent(id)}`;

export function messageNavigationItems(
  turns: TranscriptTurn[]
): MessageNavigationItem[] {
  return turns.flatMap((turn) => {
    const items: MessageNavigationItem[] = [];
    if (turn.user) {
      items.push({
        id: messageAnchor(turn.user.id),
        title:
          turn.user.text.trim() ||
          turn.user.attachments?.map((item) => item.filename).join(", ") ||
          "Attached message",
      });
    }
    for (const entry of turn.entries) {
      if (entry.kind === "steering") {
        items.push({ id: messageAnchor(entry.id), title: entry.text });
      }
    }
    return items;
  });
}
