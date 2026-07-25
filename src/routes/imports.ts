import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import { requireApiKey, ApiScope } from '../middleware/auth.js'
import {
  previewImportFile,
  IMPORT_PREVIEW_MAX_FILE_BYTES,
} from '../services/importPreviewService.js'
import { MappingPresetRepository, dryRunImportFile, type ImportDryRunResult } from '../services/imports/mapping.js'
import {
  commitImportFile,
  isDryRunQuery,
  type ImportCommitter,
  PoolImportCommitter,
} from '../services/imports/commit.js'
import { pool } from '../db/pool.js'
import { getTenantId } from '../utils/tenantContext.js'

/** Accepted MIME types for CSV uploads. */
const ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
])

/** Accepted file extensions (lower-cased). */
const ALLOWED_EXTENSIONS = new Set(['.csv'])

function csvFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
): void {
  const ext = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase()
  if (ALLOWED_MIME_TYPES.has(file.mimetype) || ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true)
  } else {
    const err = Object.assign(new Error('Only CSV files are accepted.'), {
      code: 'INVALID_FILE_TYPE',
    }) as Error & { code: string }
    cb(err)
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: IMPORT_PREVIEW_MAX_FILE_BYTES,
    files: 1,
  },
  fileFilter: csvFileFilter,
})

function handleUploadError(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: 'PayloadTooLarge',
        code: 'FileTooLarge',
        message: 'Import file exceeds the maximum allowed size.',
      })
      return
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({
        error: 'InvalidRequest',
        code: 'TooManyFiles',
        message: 'Only one file may be uploaded per request.',
      })
      return
    }
    res.status(400).json({
      error: 'InvalidRequest',
      code: 'UploadError',
      message: 'File upload failed.',
    })
    return
  }

  if (
    err instanceof Error &&
    (err as any).code === 'INVALID_FILE_TYPE'
  ) {
    res.status(415).json({
      error: 'UnsupportedMediaType',
      code: 'InvalidFileType',
      message: 'Only CSV files are accepted. Please upload a .csv file.',
    })
    return
  }

  next(err)
}

function csvUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err !== undefined) {
      handleUploadError(err, req, res, next)
      return
    }
    next()
  })
}

function requireUploadedFile(req: Request, res: Response): Buffer | null {
  const file = req.file
  if (!file?.buffer) {
    res.status(400).json({
      error: 'InvalidRequest',
      code: 'MissingFile',
      message: 'Multipart field "file" is required.',
    })
    return null
  }
  return file.buffer
}

function sendDryRunError(res: Response, result: Extract<ImportDryRunResult, { success: false }>): void {
  res.status(result.status).json({
    error: result.error,
    code: result.code,
    message: result.message,
    ...(result.row !== undefined ? { row: result.row } : {}),
  })
}

function sendDryRunSuccess(
  res: Response,
  result: Extract<ImportDryRunResult, { success: true }>,
  preset?: {
    id: string
    name: string
    version: number
    columnMappings: Record<string, string>
  },
): void {
  res.status(200).json({
    valid: result.valid,
    totalRows: result.totalRows,
    errors: result.errors,
    errorsTruncated: result.errorsTruncated,
    ...(preset ? { preset } : {}),
  })
}

export function createImportsRouter(
  repo?: MappingPresetRepository,
  committer?: ImportCommitter,
): Router {
  const router = Router()
  const presetRepo = repo ?? new MappingPresetRepository(pool)
  const importCommitter = committer ?? new PoolImportCommitter(pool)

  // -----------------------------------------------------------------------
  // POST /api/imports/preview — existing preview endpoint
  // -----------------------------------------------------------------------
  router.post(
    '/preview',
    requireApiKey(ApiScope.ENTERPRISE),
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (err !== undefined) {
          handleUploadError(err, req, res, next)
          return
        }
        next()
      })
    },
    async (req: Request, res: Response) => {
      const file = req.file
      if (!file?.buffer) {
        res.status(400).json({
          error: 'InvalidRequest',
          code: 'MissingFile',
          message: 'Multipart field "file" is required.',
        })
        return
      }

      const result = await previewImportFile(file.buffer)
      if (!result.success) {
        res.status(result.status).json({
          error: result.error,
          code: result.code,
          message: result.message,
          ...(result.line !== undefined ? { line: result.line } : {}),
        })
        return
      }

      res.status(200).json({
        summary: result.summary,
        preview: result.preview,
        rowErrors: result.rowErrors,
      })
    }
  )

  // -----------------------------------------------------------------------
  // POST /api/imports/preview/:presetId — preview with column mapping
  // -----------------------------------------------------------------------
  router.post(
    '/preview/:presetId',
    requireApiKey(ApiScope.ENTERPRISE),
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (err !== undefined) {
          handleUploadError(err, req, res, next)
          return
        }
        next()
      })
    },
    async (req: Request, res: Response) => {
      const file = req.file
      if (!file?.buffer) {
        res.status(400).json({
          error: 'InvalidRequest',
          code: 'MissingFile',
          message: 'Multipart field "file" is required.',
        })
        return
      }

      const preset = await presetRepo.findById(req.params.presetId)
      if (!preset) {
        res.status(404).json({
          error: 'NotFound',
          code: 'PresetNotFound',
          message: 'Mapping preset not found.',
        })
        return
      }

      const result = await previewImportFile(file.buffer)
      if (!result.success) {
        res.status(result.status).json({
          error: result.error,
          code: result.code,
          message: result.message,
          ...(result.line !== undefined ? { line: result.line } : {}),
        })
        return
      }

      res.status(200).json({
        summary: result.summary,
        preview: result.preview,
        rowErrors: result.rowErrors,
        preset: {
          id: preset.id,
          name: preset.name,
          version: preset.version,
          columnMappings: preset.columnMappings,
        },
      })
    }
  )

  // -----------------------------------------------------------------------
  // POST /api/imports/dry-run — validate CSV without persisting
  // -----------------------------------------------------------------------
  router.post(
    '/dry-run',
    requireApiKey(ApiScope.ENTERPRISE),
    csvUploadMiddleware,
    async (req: Request, res: Response) => {
      const buffer = requireUploadedFile(req, res)
      if (!buffer) return

      const result = await dryRunImportFile(buffer)
      if (!result.success) {
        sendDryRunError(res, result)
        return
      }

      sendDryRunSuccess(res, result)
    }
  )

  // -----------------------------------------------------------------------
  // POST /api/imports/dry-run/:presetId — dry-run with column mapping preset
  // -----------------------------------------------------------------------
  router.post(
    '/dry-run/:presetId',
    requireApiKey(ApiScope.ENTERPRISE),
    csvUploadMiddleware,
    async (req: Request, res: Response) => {
      const buffer = requireUploadedFile(req, res)
      if (!buffer) return

      const preset = await presetRepo.findById(req.params.presetId)
      if (!preset) {
        res.status(404).json({
          error: 'NotFound',
          code: 'PresetNotFound',
          message: 'Mapping preset not found.',
        })
        return
      }

      const result = await dryRunImportFile(buffer, preset.columnMappings)
      if (!result.success) {
        sendDryRunError(res, result)
        return
      }

      sendDryRunSuccess(res, result, {
        id: preset.id,
        name: preset.name,
        version: preset.version,
        columnMappings: preset.columnMappings,
      })
    }
  )

  // -----------------------------------------------------------------------
  // POST /api/imports/commit — commit import (?dryRun=true validates only)
  // -----------------------------------------------------------------------
  router.post(
    '/commit',
    requireApiKey(ApiScope.ENTERPRISE),
    csvUploadMiddleware,
    async (req: Request, res: Response) => {
      const buffer = requireUploadedFile(req, res)
      if (!buffer) return

      if (isDryRunQuery(req.query.dryRun)) {
        const result = await dryRunImportFile(buffer)
        if (!result.success) {
          sendDryRunError(res, result)
          return
        }
        sendDryRunSuccess(res, result)
        return
      }

      const result = await commitImportFile(buffer, importCommitter)
      if (!result.success) {
        sendDryRunError(res, result)
        return
      }
      if (!('committed' in result)) {
        // Validation failure: rows did not pass dry-run validation.
        res.status(422).json({
          error: 'UnprocessableEntity',
          code: 'ImportValidationFailed',
          message: 'Import file contains validation errors.',
          valid: result.valid,
          totalRows: result.totalRows,
          errors: result.errors,
          errorsTruncated: result.errorsTruncated,
        })
        return
      }

      res.status(201).json({
        committed: true,
        totalRows: result.totalRows,
        imported: result.imported,
      })
    }
  )

  // -----------------------------------------------------------------------
  // POST /api/imports/commit/:presetId — commit with mapping preset
  // -----------------------------------------------------------------------
  router.post(
    '/commit/:presetId',
    requireApiKey(ApiScope.ENTERPRISE),
    csvUploadMiddleware,
    async (req: Request, res: Response) => {
      const buffer = requireUploadedFile(req, res)
      if (!buffer) return

      const preset = await presetRepo.findById(req.params.presetId)
      if (!preset) {
        res.status(404).json({
          error: 'NotFound',
          code: 'PresetNotFound',
          message: 'Mapping preset not found.',
        })
        return
      }

      if (isDryRunQuery(req.query.dryRun)) {
        const result = await dryRunImportFile(buffer, preset.columnMappings)
        if (!result.success) {
          sendDryRunError(res, result)
          return
        }
        sendDryRunSuccess(res, result, {
          id: preset.id,
          name: preset.name,
          version: preset.version,
          columnMappings: preset.columnMappings,
        })
        return
      }

      const result = await commitImportFile(buffer, importCommitter, preset.columnMappings)
      if (!result.success) {
        sendDryRunError(res, result)
        return
      }
      if (!('committed' in result)) {
        // Validation failure: rows did not pass dry-run validation.
        res.status(422).json({
          error: 'UnprocessableEntity',
          code: 'ImportValidationFailed',
          message: 'Import file contains validation errors.',
          valid: result.valid,
          totalRows: result.totalRows,
          errors: result.errors,
          errorsTruncated: result.errorsTruncated,
          preset: {
            id: preset.id,
            name: preset.name,
            version: preset.version,
            columnMappings: preset.columnMappings,
          },
        })
        return
      }

      res.status(201).json({
        committed: true,
        totalRows: result.totalRows,
        imported: result.imported,
        preset: {
          id: preset.id,
          name: preset.name,
          version: preset.version,
          columnMappings: preset.columnMappings,
        },
      })
    }
  )

  // -----------------------------------------------------------------------
  // GET /api/imports/presets — list presets for current org
  // -----------------------------------------------------------------------
  router.get(
    '/presets',
    requireApiKey(ApiScope.ENTERPRISE),
    async (_req: Request, res: Response) => {
      const orgId = getTenantId()
      if (!orgId) {
        res.status(400).json({
          error: 'InvalidRequest',
          code: 'MissingTenant',
          message: 'Tenant context is required.',
        })
        return
      }

      const presets = await presetRepo.findByOrg(orgId)
      res.status(200).json({ presets })
    }
  )

  // -----------------------------------------------------------------------
  // POST /api/imports/presets — create a new mapping preset
  // -----------------------------------------------------------------------
  router.post(
    '/presets',
    requireApiKey(ApiScope.ENTERPRISE),
    async (req: Request, res: Response) => {
      const orgId = getTenantId()
      if (!orgId) {
        res.status(400).json({
          error: 'InvalidRequest',
          code: 'MissingTenant',
          message: 'Tenant context is required.',
        })
        return
      }

      const { name, columnMappings } = req.body

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({
          error: 'InvalidRequest',
          code: 'ValidationError',
          message: 'Field "name" is required and must be a non-empty string.',
        })
        return
      }

      if (!columnMappings || typeof columnMappings !== 'object' || Array.isArray(columnMappings)) {
        res.status(400).json({
          error: 'InvalidRequest',
          code: 'ValidationError',
          message: 'Field "columnMappings" is required and must be a non-empty object.',
        })
        return
      }

      const preset = await presetRepo.create({
        orgId,
        name: name.trim(),
        columnMappings,
      })

      res.status(201).json({ preset })
    }
  )

  // -----------------------------------------------------------------------
  // GET /api/imports/presets/:id — get a single preset
  // -----------------------------------------------------------------------
  router.get(
    '/presets/:id',
    requireApiKey(ApiScope.ENTERPRISE),
    async (req: Request, res: Response) => {
      const preset = await presetRepo.findById(req.params.id)
      if (!preset) {
        res.status(404).json({
          error: 'NotFound',
          code: 'PresetNotFound',
          message: 'Mapping preset not found.',
        })
        return
      }

      res.status(200).json({ preset })
    }
  )

  // -----------------------------------------------------------------------
  // PUT /api/imports/presets/:id — update a preset
  // -----------------------------------------------------------------------
  router.put(
    '/presets/:id',
    requireApiKey(ApiScope.ENTERPRISE),
    async (req: Request, res: Response) => {
      const { name, columnMappings } = req.body

      if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
        res.status(400).json({
          error: 'InvalidRequest',
          code: 'ValidationError',
          message: 'Field "name" must be a non-empty string.',
        })
        return
      }

      if (
        columnMappings !== undefined &&
        (typeof columnMappings !== 'object' || Array.isArray(columnMappings))
      ) {
        res.status(400).json({
          error: 'InvalidRequest',
          code: 'ValidationError',
          message: 'Field "columnMappings" must be a non-empty object.',
        })
        return
      }

      const preset = await presetRepo.update(req.params.id, {
        name: name !== undefined ? name.trim() : undefined,
        columnMappings,
      })

      if (!preset) {
        res.status(404).json({
          error: 'NotFound',
          code: 'PresetNotFound',
          message: 'Mapping preset not found.',
        })
        return
      }

      res.status(200).json({ preset })
    }
  )

  // -----------------------------------------------------------------------
  // DELETE /api/imports/presets/:id — delete a preset
  // -----------------------------------------------------------------------
  router.delete(
    '/presets/:id',
    requireApiKey(ApiScope.ENTERPRISE),
    async (req: Request, res: Response) => {
      const deleted = await presetRepo.delete(req.params.id)
      if (!deleted) {
        res.status(404).json({
          error: 'NotFound',
          code: 'PresetNotFound',
          message: 'Mapping preset not found.',
        })
        return
      }

      res.status(204).send()
    }
  )

  return router
}

export default createImportsRouter()
