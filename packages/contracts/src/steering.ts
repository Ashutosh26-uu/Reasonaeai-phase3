import { z } from "zod";
import { RunIdSchema } from "./identity.js";

export const RunSteeringRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(20_000),
});

export const RunSteeringAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  runId: RunIdSchema,
  status: z.enum(["requested", "delivering", "delivered", "failed"]),
  steeringId: z.uuid(),
});
export type RunSteeringAccepted = z.infer<typeof RunSteeringAcceptedSchema>;
