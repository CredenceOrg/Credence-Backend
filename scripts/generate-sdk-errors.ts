import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  ERROR_CATALOG,
  ERROR_CATALOG_CODES,
  type ErrorCatalogEntry,
} from '../src/lib/errorCatalog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Default on-disk location of the generated SDK. Overridable for tests. */
export const DEFAULT_OUTPUT_PATH = path.resolve(__dirname, '../src/sdk/errors.generated.ts')

/**
 * Escapes a value for embedding inside a single-quoted TypeScript string literal.
 *
 * INVARIANT: every catalog value interpolated into generated *source* must pass
 * through this. The catalog is data, but it is spliced into executable code, so
 * an unescaped `'` would terminate the literal early and let the rest of the
 * value be parsed as TypeScript — i.e. a data edit becomes code execution in a
 * file that is imported by the SDK. `defaultMessage` is already emitted via
 * `JSON.stringify`; this brings `code` and `sdkClassName` up to the same bar.
 */
export const escapeStringLiteral = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')

/** A generated class name must be a valid JS identifier to be emittable. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Reserved words that lexically match `IDENTIFIER_PATTERN` but cannot be used as
 * a class name — `export class class extends ...` is a syntax error. Checking
 * the shape alone would let these through and produce a file that fails to parse.
 */
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
])

/**
 * Rejects catalog entries that cannot be safely rendered as a class.
 *
 * `sdkClassName` is declared optional on `ErrorCatalogEntry`, so a missing or
 * malformed value previously emitted `export class undefined extends ...`,
 * producing a file that fails to parse with an error pointing at the
 * generator rather than at the offending catalog entry. Failing loudly here
 * keeps the diagnostic actionable and prevents a broken artifact from being
 * written over a working one.
 */
export const assertRenderableSdkClassName = (className: string | undefined, code: string): string => {
  if (className == null || className === '') {
    throw new Error(
      `errorCatalog entry '${code}' is missing sdkClassName; every entry must name the SDK class to generate`,
    )
  }
  if (!IDENTIFIER_PATTERN.test(className)) {
    throw new Error(
      `errorCatalog entry '${code}' has an invalid sdkClassName '${className}': expected a valid JavaScript identifier`,
    )
  }
  if (RESERVED_WORDS.has(className)) {
    throw new Error(
      `errorCatalog entry '${code}' has an invalid sdkClassName '${className}': reserved word cannot be used as a class name`,
    )
  }
  return className
}

export function buildClassBlock(entry: ErrorCatalogEntry): string {
  const lines: string[] = []
  const sdkClassName = assertRenderableSdkClassName(entry.sdkClassName, entry.code)
  const code = escapeStringLiteral(entry.code)
  const escapedClassName = escapeStringLiteral(sdkClassName)

  if (entry.deprecated) {
    const replacement = entry.replacedBy
      ? ` Use \`${escapeStringLiteral(entry.replacedBy)}\` instead.`
      : ''
    lines.push('/**')
    lines.push(` * @deprecated Legacy error code.${replacement}`)
    lines.push(' */')
  }

  lines.push(`export class ${sdkClassName} extends CredenceError {`)
  lines.push(`  static readonly errorCode = '${code}' as const`)
  lines.push('')
  lines.push('  constructor(')
  lines.push(`    message: string = DEFAULT_MESSAGES['${code}'],`)
  if (entry.httpStatus === null) {
    lines.push('    status: number,')
  } else {
    lines.push(`    status: number = ${entry.httpStatus},`)
  }
  lines.push('    details?: unknown,')
  lines.push('    options?: CredenceErrorOptions,')
  lines.push('  ) {')
  lines.push(`    super(message, '${code}', status, details, options)`)
  lines.push(`    this.name = '${escapedClassName}'`)
  lines.push('  }')
  lines.push('}')

  return lines.join('\n')
}

/**
 * Renders the `DEFAULT_MESSAGES` map.
 *
 * `defaultMessage` is emitted through `JSON.stringify`, which is both valid
 * TypeScript for the ASCII range and correctly escapes quotes, backslashes and
 * newlines — a message can never break out of its literal.
 */
export const buildDefaultMessages = (
  catalog: Record<string, ErrorCatalogEntry> = ERROR_CATALOG,
  codes: readonly string[] = ERROR_CATALOG_CODES,
): string =>
  codes
    .map((key) => `  '${escapeStringLiteral(catalog[key].code)}': ${JSON.stringify(catalog[key].defaultMessage)},`)
    .join('\n')

/**
 * Renders the `CREDENCE_ERROR_REGISTRY` entries.
 *
 * Codes are emitted in catalog order, so the generated object literal is
 * byte-stable across runs given the same catalog — which is what lets CI
 * assert the committed artifact is up to date.
 */
export const buildRegistryEntries = (
  catalog: Record<string, ErrorCatalogEntry> = ERROR_CATALOG,
  codes: readonly string[] = ERROR_CATALOG_CODES,
): string =>
  codes
    .map((key) => {
      const entry = catalog[key]
      return `  '${escapeStringLiteral(entry.code)}': ${assertRenderableSdkClassName(entry.sdkClassName, entry.code)},`
    })
    .join('\n')

/**
 * Validates that every requested catalog key resolves and that no two entries
 * collide on `code` or `sdkClassName`.
 *
 * Without this, a duplicated entry does not fail here — it silently emits two
 * `export class X` declarations (a redeclaration error that surfaces far from
 * its cause) and two identical object keys in `DEFAULT_MESSAGES` /
 * `CREDENCE_ERROR_REGISTRY`, where the later key wins and the error code
 * silently loses its typed class. Neither is a safe default, so both are
 * rejected up front.
 */
export const assertCatalogEntriesRenderable = (
  catalog: Record<string, ErrorCatalogEntry>,
  codes: readonly string[],
): readonly ErrorCatalogEntry[] => {
  const entries: ErrorCatalogEntry[] = []
  const seenKeys = new Set<string>()
  const seenCodes = new Map<string, string>()
  const seenClassNames = new Map<string, string>()

  for (const key of codes) {
    if (seenKeys.has(key)) {
      throw new Error(`errorCatalog code list contains duplicate key '${key}'`)
    }
    seenKeys.add(key)

    const entry = catalog[key]
    if (entry === undefined) {
      throw new Error(`errorCatalog code list references missing key '${key}'`)
    }

    const className = assertRenderableSdkClassName(entry.sdkClassName, entry.code)

    const priorCodeKey = seenCodes.get(entry.code)
    if (priorCodeKey !== undefined) {
      throw new Error(
        `errorCatalog has duplicate error code '${entry.code}' (keys '${priorCodeKey}' and '${key}')`,
      )
    }
    seenCodes.set(entry.code, key)

    const priorClassKey = seenClassNames.get(className)
    if (priorClassKey !== undefined) {
      throw new Error(
        `errorCatalog has duplicate sdkClassName '${className}' (keys '${priorClassKey}' and '${key}')`,
      )
    }
    seenClassNames.set(className, key)

    entries.push(entry)
  }

  return entries
}

export function generate(
  catalog: Record<string, ErrorCatalogEntry> = ERROR_CATALOG,
  codes: readonly string[] = ERROR_CATALOG_CODES,
): string {
  assertCatalogEntriesRenderable(catalog, codes)

  const defaultMessages = buildDefaultMessages(catalog, codes)

  const classBlocks = codes.map((key) => buildClassBlock(catalog[key])).join('\n\n')

  const registryEntries = buildRegistryEntries(catalog, codes)

  return `/**
 * AUTO-GENERATED by scripts/generate-sdk-errors.ts — DO NOT EDIT.
 * Regenerate with: npm run generate:sdk-errors
 */

export interface CredenceErrorEnvelope {
  error: string
  code: string
  details?: unknown
}

export interface CredenceErrorOptions {
  cause?: unknown
  rawBody?: string
}

export interface SanitizedErrorCause {
  name?: string
  message?: string
  code?: string
  cause?: SanitizedErrorCause
}

const DEFAULT_MESSAGES = {
${defaultMessages}
} as const

/**
 * Strip stack traces from an Error cause chain before serialization or attachment.
 * Prevents server-side stack traces from leaking through nested causes.
 */
export function sanitizeCauseChain(cause: unknown): SanitizedErrorCause | undefined {
  if (cause == null) return undefined

  if (cause instanceof Error) {
    const sanitized: SanitizedErrorCause = {
      name: cause.name,
      message: cause.message,
    }

    const nodeCode = (cause as Error & { code?: unknown }).code
    if (typeof nodeCode === 'string') {
      sanitized.code = nodeCode
    }

    if (cause.cause != null) {
      sanitized.cause = sanitizeCauseChain(cause.cause)
    }

    return sanitized
  }

  if (typeof cause === 'object') {
    const record = cause as Record<string, unknown>
    const sanitized: SanitizedErrorCause = {}

    if (typeof record.name === 'string') sanitized.name = record.name
    if (typeof record.message === 'string') sanitized.message = record.message
    if (typeof record.code === 'string') sanitized.code = record.code
    if ('cause' in record) sanitized.cause = sanitizeCauseChain(record.cause)

    return Object.keys(sanitized).length > 0 ? sanitized : undefined
  }

  return { message: String(cause) }
}

export class CredenceError extends Error {
  public readonly code: string
  public readonly status: number
  public readonly details?: unknown
  public readonly rawBody?: string

  constructor(
    message: string,
    code: string,
    status: number,
    details?: unknown,
    options?: CredenceErrorOptions,
  ) {
    super(message, {
      cause:
        options?.cause != null ? sanitizeCauseChain(options.cause) : undefined,
    })
    this.name = 'CredenceError'
    this.code = code
    this.status = status
    this.details = details
    this.rawBody = options?.rawBody
  }

  toJSON(): CredenceErrorEnvelope & { status: number; rawBody?: string } {
    return {
      error: this.message,
      code: this.code,
      status: this.status,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.rawBody !== undefined ? { rawBody: this.rawBody } : {}),
    }
  }
}

/**
 * Common construct signature shared by every generated CredenceError subclass.
 * Subclasses pin their \`code\` internally, so the public constructor is
 * \`(message, status, details?, options?)\`. The registry is keyed by code and
 * always instantiated via this shape.
 */
export type CredenceErrorConstructor = new (
  message: string,
  status: number,
  details?: unknown,
  options?: CredenceErrorOptions,
) => CredenceError

${classBlocks}

export const CREDENCE_ERROR_REGISTRY = {
${registryEntries}
} as const satisfies Record<string, CredenceErrorConstructor>

export type CredenceErrorCode = keyof typeof CREDENCE_ERROR_REGISTRY

export const CREDENCE_ERROR_CODES = Object.keys(CREDENCE_ERROR_REGISTRY) as CredenceErrorCode[]

export function isCredenceError(value: unknown): value is CredenceError {
  return value instanceof CredenceError
}

export function parseCredenceErrorEnvelope(body: string): CredenceErrorEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).error === 'string' &&
      typeof (parsed as Record<string, unknown>).code === 'string'
    ) {
      const envelope = parsed as CredenceErrorEnvelope
      return {
        error: envelope.error,
        code: envelope.code,
        ...(envelope.details !== undefined ? { details: envelope.details } : {}),
      }
    }
  } catch {
    return null
  }
  return null
}

export function createCredenceErrorFromEnvelope(
  envelope: CredenceErrorEnvelope,
  status: number,
  options?: CredenceErrorOptions,
): CredenceError {
  const Ctor = CREDENCE_ERROR_REGISTRY[envelope.code as CredenceErrorCode]
  if (Ctor) {
    return new Ctor(envelope.error, status, envelope.details, options)
  }

  return new SdkUnmappedHttpCredenceError(
    envelope.error,
    status,
    envelope.details,
    options,
  )
}

export function createTransportCredenceError(
  code: Extract<
    CredenceErrorCode,
    'sdk_request_timeout' | 'sdk_network_error' | 'sdk_invalid_json' | 'sdk_unmapped_http'
  >,
  message: string,
  status: number,
  options?: CredenceErrorOptions,
): CredenceError {
  const Ctor = CREDENCE_ERROR_REGISTRY[code]
  return new Ctor(message, status, undefined, options)
}
`
}

/**
 * Writes the generated SDK to disk, creating the parent directory if needed.
 *
 * Kept as a thin, separately testable wrapper around `fs` so permission / IO
 * failures (EACCES on a read-only checkout, ENOSPC, EROFS) can be exercised
 * without touching the repo, and so a failure surfaces as a thrown error
 * rather than a truncated file that would break every SDK consumer at import.
 */
export const writeGeneratedSdk = (outputPath: string, contents: string): void => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, contents, 'utf-8')
}

export interface RunGenerateSdkErrorsOptions {
  outputPath?: string
  catalog?: Record<string, ErrorCatalogEntry>
  codes?: readonly string[]
  log?: (message: string) => void
}

/**
 * Orchestrates generate-then-write.
 *
 * INVARIANTS:
 * - The whole document is rendered in memory before the file is opened, so an
 *   unrenderable catalog entry throws without ever truncating the previously
 *   committed artifact. That matters here because `errors.generated.ts` is
 *   imported directly by the SDK; a partial write would break every consumer.
 * - The success log is emitted only after the write resolves, so there is no
 *   state in which the log claims success but the file is missing or partial.
 * - Output is a pure function of (catalog, codes), so re-running on an
 *   unchanged catalog rewrites byte-identical content.
 */
export const runGenerateSdkErrors = (options: RunGenerateSdkErrorsOptions = {}): string => {
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH
  const catalog = options.catalog ?? ERROR_CATALOG
  const codes = options.codes ?? ERROR_CATALOG_CODES
  const log = options.log ?? console.log

  const contents = generate(catalog, codes)
  writeGeneratedSdk(outputPath, contents)
  log(`SDK error classes generated at ${path.relative(process.cwd(), outputPath)}`)
  return outputPath
}

// Only write when invoked as a CLI so importing this module (e.g. from tests)
// has no filesystem side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runGenerateSdkErrors()
}
