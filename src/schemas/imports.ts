/**
 * Zod schemas for the import domain — preview, dry-run, and commit endpoints.
 *
 * These schemas lock the public response contract of `/api/imports/*` so
 * downstream consumers (SDKs, postman collection, OpenAPI generation) get a
 * single source of truth instead of relying on TypeScript interfaces that
 * never reach the wire. They are validated at request time by the
 * `validate()` middleware and at test time by direct `schema.parse()` calls.
 */
import { z } from 'zod'
import {
  IMPORT_PREVIEW_MAX_ROW_ERRORS,
  IMPORT_PREVIEW_VALID_SAMPLE,
  IMPORT_PREVIEW_INVALID_SAMPLE,
} from '../services/importPreviewService.js'

/* ──────────────────────────────────────────────────────────────────────────
 * Preview endpoint — `POST /api/imports/preview`
 *
 * Streams a CSV upload and returns: counts, sample rows, row-level errors.
 * Captures counts BEFORE schema validation (matches the existing
 * `ImportPreviewSummary` interface in `importPreviewService.ts`).
 * ──────────────────────────────────────────────────────────────────────── */

/** Aggregated counts for a preview pass. Mirror of {@link ImportPreviewSummary}. */
export const importPreviewSummarySchema = z
  .object({
    totalRowsScanned: z.number().int().nonnegative(),
    validRows: z.number().int().nonnegative(),
    invalidRows: z.number().int().nonnegative(),
    truncated: z.boolean(),
    truncatedReason: z.union([z.literal('row_limit'), z.null()]),
    totalDataRowsInFile: z.number().int().nonnegative().optional(),
  })
  .strict()

/** A single valid row sample returned by the preview endpoint. */
export const importPreviewValidSampleEntrySchema = z
  .object({
    line: z.number().int().positive(),
    data: z.object({ address: z.string() }).strict(),
  })
  .strict()

/** A single invalid row sample returned by the preview endpoint. */
export const importPreviewInvalidSampleEntrySchema = z
  .object({
    line: z.number().int().positive(),
    data: z.object({ address: z.string() }).strict(),
    errors: z.array(z.string().min(1)),
  })
  .strict()

/** Bounded list of valid + invalid sample rows. */
export const importPreviewSamplesSchema = z
  .object({
    validSample: z
      .array(importPreviewValidSampleEntrySchema)
      .max(IMPORT_PREVIEW_VALID_SAMPLE),
    invalidSample: z
      .array(importPreviewInvalidSampleEntrySchema)
      .max(IMPORT_PREVIEW_INVALID_SAMPLE),
  })
  .strict()

/** Single row-level error from the preview pass. */
export const importPreviewRowErrorSchema = z
  .object({
    line: z.number().int().positive(),
    column: z.literal('address').optional(),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict()

/**
 * Successful preview response — returned as the BARE body of
 * `POST /api/imports/preview` (the route does NOT wrap with `{ success: true }`,
 * so this schema is the body shape operators should integrate against).
 */
export const importPreviewSuccessResponseSchema = z
  .object({
    summary: importPreviewSummarySchema,
    preview: importPreviewSamplesSchema,
    rowErrors: z.array(importPreviewRowErrorSchema).max(IMPORT_PREVIEW_MAX_ROW_ERRORS),
  })
  .strict()

/**
 * Error envelope returned for any non-2xx preview response.
 * Captures the canonical `code` strings emitted by the service so consumers
 * can switch on `code` rather than parsing the human-readable `message`.
 */
export const importPreviewErrorResponseSchema = z
  .object({
    error: z.string().min(1),
    code: z.enum([
      'FileTooLarge',
      'MissingFile',
      'InvalidFileType',
      'TooManyFiles',
      'UploadError',
      'InvalidEncoding',
      'SchemaError',
      'ParseTimeout',
      'CellTooLarge',
      'MalformedCsv',
    ]),
    message: z.string().min(1),
    line: z.number().int().positive().optional(),
  })
  .strict()

/* ──────────────────────────────────────────────────────────────────────────
 * Dry-run endpoint — `POST /api/imports/dry-run[/...]`
 *
 * Validates a CSV against an active column-mapping schema. Returns aggregated
 * per-row errors (no samples).
 * ──────────────────────────────────────────────────────────────────────── */

/** Single row error from the dry-run pass. Mirror of {@link ImportDryRunRowError}. */
export const importDryRunRowErrorSchema = z
  .object({
    row: z.number().int().positive(),
    column: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict()

/** Successful dry-run body. Mirror of {@link ImportDryRunSuccessBody}. */
export const importDryRunSuccessResponseSchema = z
  .object({
    valid: z.boolean(),
    totalRows: z.number().int().nonnegative(),
    errors: z.array(importDryRunRowErrorSchema),
    errorsTruncated: z.boolean(),
  })
  .strict()

/** Error envelope for any non-2xx dry-run response. */
export const importDryRunErrorResponseSchema = z
  .object({
    error: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
    row: z.number().int().positive().optional(),
  })
  .strict()

/* ──────────────────────────────────────────────────────────────────────────
 * Commit endpoint — `POST /api/imports/commit[/...]`
 *
 * Persists validated rows. Returns either a success body, a validation-failure
 * body (subset of a dry-run success body with `valid: false`), or any of
 * the dry-run error envelopes above.
 * ──────────────────────────────────────────────────────────────────────── */

/** Successful commit body. */
export const importCommitSuccessResponseSchema = z
  .object({
    committed: z.boolean(),
    totalRows: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
    operationId: z.string().min(1),
    partial: z.boolean(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    retried: z.number().int().nonnegative(),
    rowOutcomes: z.array(z.object({
      row: z.number().int().positive(),
      rowKey: z.string().min(1),
      status: z.enum(['accepted', 'rejected', 'retryable']),
      code: z.string().min(1),
      message: z.string().min(1),
    }).strict()),
  })
  .strict()

/** 422 commit-validation-failure body. Same shape as a dry-run success with `valid: false`. */
export const importCommitValidationFailureSchema = z
  .object({
    valid: z.literal(false),
    totalRows: z.number().int().nonnegative(),
    errors: z.array(importDryRunRowErrorSchema),
    errorsTruncated: z.boolean(),
    rowOutcomes: z.array(z.object({
      row: z.number().int().positive(),
      rowKey: z.string().min(1),
      status: z.literal('rejected'),
      code: z.string().min(1),
      message: z.string().min(1),
    }).strict()).optional(),
  })
  .strict()

/* ──────────────────────────────────────────────────────────────────────────
 * Re-export TypeScript types alongside each schema. Mirrors the conventions
 * used by `src/schemas/index.ts` (z.infer-derived types named after the
 * schema).
 * ──────────────────────────────────────────────────────────────────────── */

export type ImportPreviewSummary = z.infer<typeof importPreviewSummarySchema>
export type ImportPreviewValidSampleEntry = z.infer<
  typeof importPreviewValidSampleEntrySchema
>
export type ImportPreviewInvalidSampleEntry = z.infer<
  typeof importPreviewInvalidSampleEntrySchema
>
export type ImportPreviewSamples = z.infer<typeof importPreviewSamplesSchema>
export type ImportPreviewRowError = z.infer<typeof importPreviewRowErrorSchema>
export type ImportPreviewSuccessResponse = z.infer<
  typeof importPreviewSuccessResponseSchema
>
export type ImportPreviewErrorResponse = z.infer<
  typeof importPreviewErrorResponseSchema
>

export type ImportDryRunRowError = z.infer<typeof importDryRunRowErrorSchema>
export type ImportDryRunSuccessResponse = z.infer<
  typeof importDryRunSuccessResponseSchema
>
export type ImportDryRunErrorResponse = z.infer<
  typeof importDryRunErrorResponseSchema
>

export type ImportCommitSuccessResponse = z.infer<
  typeof importCommitSuccessResponseSchema
>
export type ImportCommitValidationFailure = z.infer<
  typeof importCommitValidationFailureSchema
>
