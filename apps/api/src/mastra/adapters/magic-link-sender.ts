/**
 * Magic-link delivery boundary.
 *
 * A sign-in link reaches the user through an email provider, which is an
 * external integration this environment does not have. Until one is configured
 * the product ships a development sender that writes the link to this
 * process's own stdout, so a developer can finish a sign-in locally.
 *
 * Two properties make that sender honest rather than a disguised integration:
 *
 * - It announces itself in the output. A mock delivery must never read like a
 *   delivered email, so the line names the sender as the development one and
 *   says plainly that nothing was sent.
 * - It refuses to run outside development. In production, printing a sign-in
 *   link would hand the account to anyone who can read the process output, so
 *   the sender fails loudly instead. Nothing is delivered, which is what the
 *   caller is told.
 *
 * The real provider adapter replaces this one behind the same contract: the
 * route hands it an address and a URL and never learns how the message travelled.
 */

/** Why a link was not delivered, as a stable value rather than prose. */
export const MAGIC_LINK_SENDER_UNCONFIGURED = "magic_link_sender_unconfigured";

/**
 * Raised when sign-in cannot be completed because no real sender is wired.
 * Typed so a caller can distinguish "this deployment cannot send mail" from a
 * provider failure, and actionable so an operator knows exactly what is missing.
 */
export class MagicLinkSenderUnconfiguredError extends Error {
  readonly code = MAGIC_LINK_SENDER_UNCONFIGURED;

  constructor() {
    super(
      "No magic-link sender is configured for this environment, so the sign-in link was not delivered. Configure an email provider behind the MagicLinkSender contract."
    );
    this.name = "MagicLinkSenderUnconfiguredError";
  }
}

export interface MagicLinkSender {
  send: (input: { email: string; url: string }) => Promise<void>;
}

/**
 * The sender this deployment ships with. It delivers by printing, which is
 * only ever a development behavior: outside development there is no sender at
 * all, and asking for a link fails as `MagicLinkSenderUnconfiguredError`
 * rather than succeeding without sending anything.
 */
export function createMagicLinkSender(
  config: { environment?: string } = {}
): MagicLinkSender {
  const environment = config.environment ?? process.env.NODE_ENV ?? "";
  const development = environment !== "production";

  return {
    send: async ({ email, url }) => {
      if (!development) {
        throw new MagicLinkSenderUnconfiguredError();
      }

      // The token is in the URL, and printing it is the entire point of this
      // sender: the link exists only here and in the recipient's mailbox, and
      // this deployment has neither. It never reaches a log, a database, or a
      // response body.
      //
      // The write is awaited to its callback rather than fired and forgotten,
      // so "delivered" means the link reached the stream instead of merely
      // being handed to a buffer the process may exit before flushing.
      await new Promise<void>((resolve) => {
        process.stdout.write(
          `[magic-link:development-only] no email was sent to ${email}; open this sign-in link yourself:\n${url}\n`,
          () => resolve()
        );
      });
    },
  };
}
