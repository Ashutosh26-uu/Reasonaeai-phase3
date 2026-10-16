import type { DeploymentExposure } from "@reasonateai/contracts/execution";

export interface ExposurePolicyInput {
  readonly publicApproval?: boolean;
  readonly publicCapability?: boolean;
  /**
   * Authenticated exposure is the safe default. Public exposure is never
   * inferred from a missing value.
   */
  readonly requested?: DeploymentExposure;
}

export interface ExposurePolicyDecision {
  readonly exposure: DeploymentExposure;
  readonly requiresAudit: boolean;
}

export class ExposurePolicyError extends Error {
  override readonly name = "ExposurePolicyError";
}

/**
 * Public exposure is a separate, explicit decision from deployment. Both a
 * capability decision and an approval are required; an unlisted URL is
 * allowed without making the product public.
 */
export function decideExposure(
  input: ExposurePolicyInput = {}
): ExposurePolicyDecision {
  const exposure = input.requested ?? "authenticated";
  if (
    exposure === "public" &&
    (input.publicApproval !== true || input.publicCapability !== true)
  ) {
    throw new ExposurePolicyError(
      "Public deployment requires explicit approval and the public-exposure capability."
    );
  }

  return {
    exposure,
    requiresAudit: exposure === "public",
  };
}
