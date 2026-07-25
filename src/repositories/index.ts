export { IdentitiesRepository } from "./identities.repository.js";
export type { Identity, CreateIdentityInput } from "./identities.repository.js";

export { AttestationsRepository } from "../db/repositories/attestationsRepository.js";
export type {
  Attestation,
  CreateAttestationInput,
} from "../db/repositories/attestationsRepository.js";

export { SlashEventsRepository } from "./slashEvents.repository.js";
export type {
  SlashEvent,
  CreateSlashEventInput,
} from "./slashEvents.repository.js";
