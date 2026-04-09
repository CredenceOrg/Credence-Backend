import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import {
  type AuthenticatedRequest,
  type UserRole,
  requireAdminRole,
  requireUserAuth,
} from '../middleware/auth.js'
import { EvidenceStorageService, type Role } from '../services/evidence/storage.js'
import { auditLogService, AuditAction } from '../services/audit/index.js'

const router = Router()
let storageService: EvidenceStorageService | null = null

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

router.post('/upload', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!
  const { evidenceId, rawData } = req.body as { evidenceId?: string; rawData?: string }

  if (!rawData || typeof rawData !== 'string') {
    res.status(400).json({ error: 'BadRequest', message: 'rawData is required' })
    return
  }

  const finalEvidenceId = evidenceId && evidenceId.trim().length > 0 ? evidenceId : randomUUID()

  try {
    const record = await getStorageService().uploadEvidence(finalEvidenceId, rawData, actor.id)

    await auditLogService.logAction({
      actorId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.EVIDENCE_UPLOADED,
      resourceType: 'evidence',
      resourceId: finalEvidenceId,
      details: { uploaderId: record.uploaderId },
    })

    res.status(201).json(record)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await auditLogService.logAction({
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
})

router.get('/:evidenceId', requireUserAuth, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest
  const actor = authReq.user!
  const evidenceId = req.params.evidenceId
  const role = toEvidenceRole(actor.role)

  try {
    const decrypted = await getStorageService().retrieveEvidence(evidenceId, role)

    await auditLogService.logAction({
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
