import { z } from "zod";

export const MAGIC_LINK_SENDER_UNCONFIGURED = "magic_link_sender_unconfigured";
export class MagicLinkSenderUnconfiguredError extends Error {
  readonly code = MAGIC_LINK_SENDER_UNCONFIGURED;
  constructor() {
    super(
      "Email sign-in is unavailable. Ask the administrator to configure the email provider."
    );
    this.name = "MagicLinkSenderUnconfiguredError";
  }
}
export class MagicLinkDeliveryError extends Error {
  constructor(
    message = "We could not send your sign-in email. Please try again shortly.",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MagicLinkDeliveryError";
  }
}
export interface MagicLinkSender {
  delivery?: "email" | "local" | "unavailable";
  send: (input: { email: string; url: string }) => Promise<void>;
}

/** Real provider delivery; local capture is explicit and never prints credentials. */
export function createMagicLinkSender(
  config: {
    environment?: string;
    apiKey?: string;
    from?: string;
    mailpitUrl?: string;
    fetch?: typeof fetch;
  } = {}
): MagicLinkSender {
  const environment = config.environment ?? process.env.NODE_ENV;
  const apiKey = config.apiKey ?? process.env.RESEND_API_KEY;
  const from = config.from ?? process.env.REASONATE_EMAIL_FROM;
  const mailpitUrl = config.mailpitUrl ?? process.env.REASONATE_MAILPIT_URL;
  const local = environment === "development" && Boolean(mailpitUrl);
  const configured = Boolean(apiKey && from);
  let delivery: "local" | "email" | "unavailable" = "unavailable";
  if (configured) {
    delivery = "email";
  }
  if (local) {
    delivery = "local";
  }
  if (local) {
    const url = new URL(mailpitUrl ?? "");
    if (
      !(
        ["http:", "https:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ) ||
      url.username ||
      url.password
    ) {
      throw new Error("The development mailbox must be a loopback URL.");
    }
  }
  return {
    delivery,
    send: async ({ email, url }) => {
      if (delivery === "unavailable") {
        throw new MagicLinkSenderUnconfiguredError();
      }
      const text = `Continue to ReasonateAI using this single-use link:\n\n${url}\n\nIt expires in 15 minutes. If you did not request this email, you can ignore it.`;
      try {
        const response = await (config.fetch ?? fetch)(
          local
            ? new URL("/api/v1/send", mailpitUrl).href
            : "https://api.resend.com/emails",
          {
            body: JSON.stringify(
              local
                ? {
                    From: {
                      Email: "signin@reasonate.test",
                      Name: "ReasonateAI",
                    },
                    Subject: "Your ReasonateAI sign-in link",
                    Text: text,
                    To: [{ Email: email }],
                  }
                : {
                    from,
                    subject: "Your ReasonateAI sign-in link",
                    text,
                    to: [email],
                  }
            ),
            headers: {
              "Content-Type": "application/json",
              ...(local ? {} : { Authorization: `Bearer ${apiKey}` }),
            },
            method: "POST",
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!response.ok) {
          throw new MagicLinkDeliveryError();
        }
        const accepted = z.object(
          local ? { ID: z.string().min(1) } : { id: z.string().min(1) }
        );
        accepted.parse(await response.json());
      } catch (cause) {
        throw new MagicLinkDeliveryError(undefined, { cause });
      }
    },
  };
}
