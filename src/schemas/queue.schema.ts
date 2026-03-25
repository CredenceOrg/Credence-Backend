import { z } from 'zod';

/**
 * Define the versioned payloads for different queue tasks.
 * Requirement: Maintain versioned schemas for each message type.
 */
export const IdentityUpdateSchemaV1 = z.object({
  version: z.literal(1),
  entityId: z.number(),
  newAddress: z.string().regex(/^G[A-Z2-7]{55}$/), // Stellar G-address validation
  timestamp: z.string().datetime(),
});

export const TrustRecalcSchemaV1 = z.object({
  version: z.literal(1),
  address: z.string(),
  reason: z.enum(['manual', 'automated_periodic']),
});

// Registry to route validation based on message type
export const QueueSchemaRegistry = {
  'identity.update': IdentityUpdateSchemaV1,
  'trust.recalculate': TrustRecalcSchemaV1,
};

export type QueueMessageType = keyof typeof QueueSchemaRegistry;