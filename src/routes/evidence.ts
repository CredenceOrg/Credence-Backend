import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import client from 'prom-client'
import {
  type AuthenticatedRequest,
  type UserRole,
  requireAdminRole,
  requireUserAuth,
} from '../middleware/auth.js'
import { EvidenceStorageService, type Role } from '../services/evidence/storage.js'
import { auditLogService, AuditAction } from '../services/audit/index.js'
import { register } from '../middleware/metrics.js'

const router = Router()
let storageService: EvidenceStorageService | null = null

// ============================================================================
// Evidence Upload Security Configuration
// ============================================================================

/** Maximum file size for evidence uploads (10MB) */
const EVIDENCE_MAX_FILE_SIZE = 10 * 1024 * 1024

/** Maximum number of files per request */
const EVIDENCE_MAX_FILES = 5

/** Maximum field size for form fields */
const EVIDENCE_MAX_FIELD_SIZE = 1024 * 1024

/** Accepted MIME types for evidence files */
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/json',
  'text/csv',
])

/** Accepted file extensions (lower-cased) */
const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.txt', '.json', '.csv'
])

/** Magic number signatures for content validation */
const MAGIC_NUMBERS: Record<string, Buffer> = {
  'image/jpeg': Buffer.from([0xFF, 0xD8, 0xFF]),
  'image/png': Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  'image/gif': Buffer.from([0x47, 0x49, 0x46, 0x38]),
  'image/webp': Buffer.from([0x52, 0x49, 0x46, 0x46]),
  'application/pdf': Buffer.from([0x25, 0x50, 0x44, 0x46]),
}

// ============================================================================
// Metrics
// ============================================================================

export const evidenceUploadRejectedTotal = new client.Counter({
  name: 'evidence_upload_rejected_total',
  help: 'Total number of rejected evidence uploads by reason',
  labelNames: ['reason'],
  registers: [register]
})

export const evidenceUploadAcceptedTotal = new client.Counter({
  name: 'evidence_upload_accepted_total',
  help: 'Total number of accepted evidence uploads',
  registers: [register]
})

function getStorageService(): EvidenceStorageService {
  if (!storageService) {
    storageService = new EvidenceStorageService()
  }

  return storageService
}

function toEvidenceRole(userRole: UserRole): Role {
  if (userRole === 'admin') return 'GOVERNANCE'
  if (userRole === 'verifier') return 'ARBITRATOR'
  return 'USER'
}

// ============================================================================
// Multer Configuration
// ============================================================================

/**
 * Validates file MIME type and extension against allow-lists.
 * Also performs magic-number validation where feasible.
 */
function evidenceFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
): void {
  const ext = path.extname(file.originalname).toLowerCase()
  
  if (!ext) {
    evidenceUploadRejectedTotal.inc({ reason: 'invalid_extension' })
    const err = Object.assign(new Error('File extension is required.'), {
      code: 'INVALID_EXTENSION',
    }) as Error & { code: string }
    cb(err)
    return
  }

  // Check extension
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    evidenceUploadRejectedTotal.inc({ reason: 'invalid_extension' })
    const err = Object.assign(new Error(`File extension ${ext} is not allowed. Allowed extensions: ${Array.from(ALLOWED_EXTENSIONS).join(', ')}`), {
      code: 'INVALID_EXTENSION',
    }) as Error & { code: string }
    cb(err)
    return
  }
  
  // Check MIME type
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    evidenceUploadRejectedTotal.inc({ reason: 'invalid_mime_type' })
    const err = Object.assign(new Error(`MIME type ${file.mimetype} is not allowed. Allowed types: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}`), {
      code: 'INVALID_MIME_TYPE',
    }) as Error & { code: string }
    cb(err)
    return
  }

  cb(null, true)
}

function validateEvidenceFiles(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const files = req.files as Express.Multer.File[] | undefined

  if (!files || files.length === 0) {
    evidenceUploadRejectedTotal.inc({ reason: 'no_files' })
    res.status(400).json({
      error: 'BadRequest',
      code: 'NoFiles',
      message: 'At least one file is required in the "files" field.',
    })
    return
  }

  for (const file of files) {
    if (!file.buffer || file.buffer.length === 0) {
      evidenceUploadRejectedTotal.inc({ reason: 'empty_file' })
      res.status(400).json({
        error: 'BadRequest',
        code: 'EmptyFile',
        message: `File ${file.originalname} is empty and must contain evidence content.`,
      })
      return
    }

    const signature = MAGIC_NUMBERS[file.mimetype]
    if (signature) {
      const fileHeader = file.buffer.slice(0, signature.length)
      if (!fileHeader.equals(signature)) {
        evidenceUploadRejectedTotal.inc({ reason: 'magic_number_mismatch' })
        res.status(400).json({
          error: 'BadRequest',
          code: 'ContentMismatch',
          message: `File content does not match declared MIME type ${file.mimetype}`,
        })
        return
      }
    }
  }

  next()
}

/**
 * Multer instance configured with security limits for evidence uploads.
 * Uses memory storage to avoid temp file persistence issues.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: EVIDENCE_MAX_FILE_SIZE,
    files: EVIDENCE_MAX_FILES,
    fieldSize: EVIDENCE_MAX_FIELD_SIZE,
  },
  fileFilter: evidenceFileFilter,
})

/**
 * Handles multer errors and converts them to standard error responses.
 * Ensures temp files are cleaned up on rejection (memory storage avoids disk cleanup).
 */
function handleUploadError(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      evidenceUploadRejectedTotal.inc({ reason: 'file_too_large' })
      res.status(413).json({
        error: 'PayloadTooLarge',
        code: 'FileTooLarge',
        message: `Evidence file exceeds maximum size of ${EVIDENCE_MAX_FILE_SIZE / 1024 / 1024}MB.`,
      })
      return
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      evidenceUploadRejectedTotal.inc({ reason: 'too_many_files' })
      res.status(400).json({
        error: 'BadRequest',
        code: 'TooManyFiles',
        message: `Maximum ${EVIDENCE_MAX_FILES} files allowed per request.`,
      })
      return
    }
    // `LIMIT_FIELD_SIZE` is emitted by multer at runtime when the `fieldSize`
    // limit is exceeded, but it is missing from the @types/multer ErrorCode
    // union; widen to string for the comparison.
    if ((err.code as string) === 'LIMIT_FIELD_SIZE') {
      evidenceUploadRejectedTotal.inc({ reason: 'field_too_large' })
      res.status(413).json({
        error: 'PayloadTooLarge',
        code: 'FieldTooLarge',
        message: `Form field exceeds maximum size of ${EVIDENCE_MAX_FIELD_SIZE / 1024}KB.`,
      })
      return
    }
    evidenceUploadRejectedTotal.inc({ reason: 'multer_error' })
    res.status(400).json({
      error: 'BadRequest',
      code: 'UploadError',
      message: 'File upload failed.',
    })
    return
  }

  if (err instanceof Error && (err as any).code === 'INVALID_EXTENSION') {
    res.status(415).json({
      error: 'UnsupportedMediaType',
      code: 'InvalidFileType',
      message: err.message,
    })
    return
  }

  if (err instanceof Error && (err as any).code === 'INVALID_MIME_TYPE') {
    res.status(415).json({
      error: 'UnsupportedMediaType',
      code: 'InvalidMimeType',
      message: err.message,
    })
    return
  }

  if (err instanceof Error && (err as any).code === 'MAGIC_NUMBER_MISMATCH') {
    res.status(400).json({
      error: 'BadRequest',
      code: 'ContentMismatch',
      message: err.message,
    })
    return
  }

  next(err)
}

router.post(
  '/upload',
  requireUserAuth,
  requireAdminRole,
  (req: Request, res: Response, next: NextFunction) => {
    upload.array('files', EVIDENCE_MAX_FILES)(req, res, (err: unknown) => {
      if (err !== undefined) {
        handleUploadError(err, req, res, next)
        return
      }
      next()
    })
  },
  validateEvidenceFiles,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest
    const actor = authReq.user!
    const files = req.files as Express.Multer.File[]
    const { evidenceId } = req.body as { evidenceId?: string }

    if (!files || files.length === 0) {
      evidenceUploadRejectedTotal.inc({ reason: 'no_files' })
      res.status(400).json({
        error: 'BadRequest',
        code: 'NoFiles',
        message: 'At least one file is required in the "files" field.',
      })
      return
    }

    const finalEvidenceId = evidenceId && evidenceId.trim().length > 0 ? evidenceId : randomUUID()

    try {
      // Convert file buffers to base64 strings for storage
      const rawData = files
        .map((file) => {
          const base64 = file.buffer.toString('base64')
          return `data:${file.mimetype};base64,${base64}`
        })
        .join('\n')

      const record = await getStorageService().uploadEvidence(finalEvidenceId, rawData, actor.id)

      await auditLogService.logAction({
        tenantId: actor.tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: AuditAction.EVIDENCE_UPLOADED,
        resourceType: 'evidence',
        resourceId: finalEvidenceId,
        details: { uploaderId: record.uploaderId, fileCount: files.length },
      })

      evidenceUploadAcceptedTotal.inc()
      res.status(201).json(record)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      evidenceUploadRejectedTotal.inc({ reason: 'storage_error' })
      await auditLogService.logAction({
        tenantId: actor.tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: AuditAction.EVIDENCE_UPLOADED,
        resourceType: 'evidence',
        resourceId: finalEvidenceId,
        details: {},
        status: 'failure',
        errorMessage: message,
      })
      res.status(400).json({ error: 'BadRequest', message })
    }
  }
)

router.get('/:evidenceId', requireUserAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!
  const evidenceId = req.params.evidenceId
  const role = toEvidenceRole(actor.role)

  try {
    const decrypted = await getStorageService().retrieveEvidence(evidenceId, role)

    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.EVIDENCE_ACCESSED,
      resourceType: 'evidence',
      resourceId: evidenceId,
      details: { role },
    })

    res.status(200).json({ evidenceId, data: decrypted })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await auditLogService.logAction({
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.EVIDENCE_ACCESSED,
      resourceType: 'evidence',
      resourceId: evidenceId,
      details: { role },
      status: 'failure',
      errorMessage: message,
    })

    if (message.includes('Unauthorized')) {
      res.status(403).json({ error: 'Forbidden', message })
      return
    }

    if (message.includes('not found')) {
      res.status(404).json({ error: 'NotFound', message })
      return
    }

    res.status(400).json({ error: 'BadRequest', message })
  }
})

export default router
