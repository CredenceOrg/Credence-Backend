import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import { requireApiKey, ApiScope } from '../middleware/auth.js'
import {
  previewImportFile,
  IMPORT_PREVIEW_MAX_FILE_BYTES,
} from '../services/importPreviewService.js'

const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMPORT_PREVIEW_MAX_FILE_BYTES },
})

function handleUploadError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: 'PayloadTooLarge',
        code: 'FileTooLarge',
        message: 'Import file exceeds the maximum allowed size.',
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
  next(err)
}

/**
 * POST /api/imports/preview
 *
 * Accepts multipart/form-data with field `file` (CSV). Validates schema and Stellar addresses;
 * returns summary counts and row-level errors without persisting data.
 */
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
  (req: Request, res: Response) => {
    const file = req.file
    if (!file?.buffer) {
      res.status(400).json({
        error: 'InvalidRequest',
        code: 'MissingFile',
        message: 'Multipart field "file" is required.',
      })
      return
    }

    const result = previewImportFile(file.buffer)
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
  },
)

export default router
