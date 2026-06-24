import { z } from "zod";
import { addressSchema } from "./address.js";

/**
 * Path params for GET /api/trust/:address
 */
export const trustPathParamsSchema = z.object({
  address: addressSchema,
});

/**
 * Query params for GET /api/trust/:address/explain
 */
export const trustExplainQuerySchema = z.object({
  snapshotId: z.preprocess((value) => {
    if (typeof value === "string") return Number(value);
    return value;
  }, z.number().int().positive()),
});

/**
 * Optional query params for GET /api/trust/:address
 */
export const trustQuerySchema = z.object({}).strict();

export type TrustPathParams = z.infer<typeof trustPathParamsSchema>;
export type TrustQuery = z.infer<typeof trustQuerySchema>;
export type TrustExplainQuery = z.infer<typeof trustExplainQuerySchema>;
