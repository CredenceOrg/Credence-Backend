import { z } from "zod";

export const roleSchema = z.string().min(1);
export const actionSchema = z.string().min(1);
export const resourceSchema = z.string().min(1);

export const permissionCheckRequestSchema = z.object({
  roles: z.array(roleSchema),
  action: actionSchema,
  resource: resourceSchema,
});

export type PermissionCheckRequest = z.infer<typeof permissionCheckRequestSchema>;

export const permissionDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  ruleMatched: z.string().optional(),
  timestamp: z.string().datetime(),
  context: z.record(z.any()).optional(),
});

export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
