import { z } from "zod";

/**
 * The single error envelope for every authenticated product route. The browser
 * client switches on `code`, never on prose, and a denial never reveals whether
 * a resource exists in another tenant.
 */
export const apiErrorCodes = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "invalid_request",
  "rate_limited",
  "unsupported",
  "internal",
] as const;

export const ApiErrorCodeSchema = z.enum(apiErrorCodes);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(512),
    requestId: z.string().min(1).max(128),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const apiErrorStatus: Record<ApiErrorCode, number> = {
  conflict: 409,
  forbidden: 403,
  internal: 500,
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  unauthenticated: 401,
  unsupported: 501,
};
