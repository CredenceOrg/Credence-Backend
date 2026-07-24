/**
 * Shared zod + OpenAPI setup.
 *
 * `@asteasolutions/zod-to-openapi` augments the Zod type system (and runtime
 * prototype) with a `.openapi()` method via `extendZodWithOpenApi`. The
 * augmentation must be applied exactly once, before any schema uses
 * `.openapi()`. Import `z` from this module (instead of directly from `zod`)
 * in any schema file that annotates schemas for OpenAPI generation so the
 * augmentation is guaranteed to be loaded at type-check and runtime.
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

export { z }
