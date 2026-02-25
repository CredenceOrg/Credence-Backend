import { Router, Request, Response } from 'express'
import { requireApiKey, ApiScope, AuthenticatedRequest } from '../middleware/auth.js'
import { SlashService } from '../services/slash/slashService.js'
import { SlashStatus } from '../services/slash/types.js'
import type {
  CreateSlashRequestInput,
  ReviewSlashRequestInput,
  ExecuteSlashRequestInput,
  SlashRequestFilters,
} from '../services/slash/types.js'

const router = Router()
const slashService = new SlashService()

/**
 * POST /api/slash/submit
 * 
 * Submit a new slash request (verifier only)
 * 
 * @requires Enterprise API key via X-API-Key header
 * 
 * @body {object} Slash request details
 * @body {string} targetAddress - Stellar address to slash
 * @body {string} amount - Amount to slash (in XLM)
 * @body {string} reason - Detailed reason (min 10 chars)
 * @body {string} evidenceRef - Evidence reference (URL, IPFS hash, etc.)
 * @body {string} submittedBy - Stellar address of submitter (verifier)
 * 
 * @returns {object} Created slash request
 * 
 * @example Request
 * ```json
 * {
 *   "targetAddress": "GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
 *   "amount": "100.5",
 *   "reason": "Malicious behavior detected: submitted false attestations",
 *   "evidenceRef": "https://evidence.example.com/case-123",
 *   "submittedBy": "GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ"
 * }
 * ```
 * 
 * @example Response (201 Created)
 * ```json
 * {
 *   "id": "550e8400-e29b-41d4-a716-446655440000",
 *   "targetAddress": "GABC...",
 *   "amount": "100.5",
 *   "reason": "Malicious behavior detected...",
 *   "evidenceRef": "https://evidence.example.com/case-123",
 *   "status": "pending",
 *   "submittedBy": "GDEF...",
 *   "submittedAt": "2024-02-25T10:30:00.000Z",
 *   "reviewedBy": null,
 *   "reviewedAt": null,
 *   "reviewNotes": null,
 *   "executedAt": null,
 *   "executionTxHash": null,
 *   "createdAt": "2024-02-25T10:30:00.000Z",
 *   "updatedAt": "2024-02-25T10:30:00.000Z"
 * }
 * ```
 */
router.post(
  '/submit',
  requireApiKey(ApiScope.ENTERPRISE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const input: CreateSlashRequestInput = {
        targetAddress: req.body.targetAddress,
        amount: req.body.amount,
        reason: req.body.reason,
        evidenceRef: req.body.evidenceRef,
        submittedBy: req.body.submittedBy,
      }

      const slashRequest = await slashService.createSlashRequest(input)

      res.status(201).json(slashRequest)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Validation failed')) {
        res.status(400).json({
          error: 'ValidationError',
          message: error.message,
        })
        return
      }

      console.error('Error creating slash request:', error)
      res.status(500).json({
        error: 'InternalServerError',
        message: 'Failed to create slash request',
      })
    }
  }
)

/**
 * GET /api/slash/list
 * 
 * List slash requests with optional filters
 * 
 * @requires Enterprise API key via X-API-Key header
 * 
 * @query {string} [status] - Filter by status (pending, approved, rejected, executed)
 * @query {string} [targetAddress] - Filter by target address
 * @query {string} [submittedBy] - Filter by submitter address
 * @query {number} [limit=50] - Number of results per page (max 100)
 * @query {number} [offset=0] - Pagination offset
 * 
 * @returns {object} Paginated list of slash requests
 * 
 * @example Response (200 OK)
 * ```json
 * {
 *   "data": [
 *     {
 *       "id": "550e8400-e29b-41d4-a716-446655440000",
 *       "targetAddress": "GABC...",
 *       "amount": "100.5",
 *       "status": "pending",
 *       ...
 *     }
 *   ],
 *   "total": 42,
 *   "limit": 50,
 *   "offset": 0
 * }
 * ```
 */
router.get(
  '/list',
  requireApiKey(ApiScope.ENTERPRISE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const filters: SlashRequestFilters = {
        status: req.query.status as SlashStatus | undefined,
        targetAddress: req.query.targetAddress as string | undefined,
        submittedBy: req.query.submittedBy as string | undefined,
        limit: req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), 100) : 50,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
      }

      const result = await slashService.listSlashRequests(filters)

      res.status(200).json(result)
    } catch (error) {
      console.error('Error listing slash requests:', error)
      res.status(500).json({
        error: 'InternalServerError',
        message: 'Failed to list slash requests',
      })
    }
  }
)

/**
 * GET /api/slash/:id
 * 
 * Get slash request by ID
 * 
 * @requires Enterprise API key via X-API-Key header
 * 
 * @param {string} id - Slash request UUID
 * 
 * @returns {object} Slash request details
 * 
 * @example Response (200 OK)
 * ```json
 * {
 *   "id": "550e8400-e29b-41d4-a716-446655440000",
 *   "targetAddress": "GABC...",
 *   "amount": "100.5",
 *   "reason": "Malicious behavior detected...",
 *   "evidenceRef": "https://evidence.example.com/case-123",
 *   "status": "approved",
 *   "submittedBy": "GDEF...",
 *   "submittedAt": "2024-02-25T10:30:00.000Z",
 *   "reviewedBy": "GHIJ...",
 *   "reviewedAt": "2024-02-25T11:00:00.000Z",
 *   "reviewNotes": "Evidence verified, approved for execution",
 *   "executedAt": null,
 *   "executionTxHash": null,
 *   "createdAt": "2024-02-25T10:30:00.000Z",
 *   "updatedAt": "2024-02-25T11:00:00.000Z"
 * }
 * ```
 * 
 * @example Error Response (404 Not Found)
 * ```json
 * {
 *   "error": "NotFound",
 *   "message": "Slash request not found"
 * }
 * ```
 */
router.get(
  '/:id',
  requireApiKey(ApiScope.ENTERPRISE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params

      const slashRequest = await slashService.getSlashRequestById(id)

      if (!slashRequest) {
        res.status(404).json({
          error: 'NotFound',
          message: 'Slash request not found',
        })
        return
      }

      res.status(200).json(slashRequest)
    } catch (error) {
      console.error('Error getting slash request:', error)
      res.status(500).json({
        error: 'InternalServerError',
        message: 'Failed to get slash request',
      })
    }
  }
)

/**
 * POST /api/slash/:id/review
 * 
 * Review a slash request (approve or reject)
 * 
 * @requires Enterprise API key via X-API-Key header
 * 
 * @param {string} id - Slash request UUID
 * @body {string} status - New status (approved or rejected)
 * @body {string} reviewedBy - Stellar address of reviewer
 * @body {string} [reviewNotes] - Optional review notes
 * 
 * @returns {object} Updated slash request
 * 
 * @example Request
 * ```json
 * {
 *   "status": "approved",
 *   "reviewedBy": "GHIJ7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ",
 *   "reviewNotes": "Evidence verified, approved for execution"
 * }
 * ```
 */
router.post(
  '/:id/review',
  requireApiKey(ApiScope.ENTERPRISE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params
      const { status, reviewedBy, reviewNotes } = req.body

      if (!status || (status !== 'approved' && status !== 'rejected')) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'Status must be either "approved" or "rejected"',
        })
        return
      }

      if (!reviewedBy) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'reviewedBy is required',
        })
        return
      }

      const input: ReviewSlashRequestInput = {
        id,
        status: status as SlashStatus.APPROVED | SlashStatus.REJECTED,
        reviewedBy,
        reviewNotes,
      }

      const slashRequest = await slashService.reviewSlashRequest(input)

      res.status(200).json(slashRequest)
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          res.status(404).json({
            error: 'NotFound',
            message: error.message,
          })
          return
        }
        if (error.message.includes('status')) {
          res.status(400).json({
            error: 'InvalidStatusTransition',
            message: error.message,
          })
          return
        }
      }

      console.error('Error reviewing slash request:', error)
      res.status(500).json({
        error: 'InternalServerError',
        message: 'Failed to review slash request',
      })
    }
  }
)

/**
 * POST /api/slash/:id/execute
 * 
 * Execute an approved slash request
 * 
 * @requires Enterprise API key via X-API-Key header
 * 
 * @param {string} id - Slash request UUID
 * @body {string} executionTxHash - Transaction hash of the execution
 * 
 * @returns {object} Updated slash request
 * 
 * @example Request
 * ```json
 * {
 *   "executionTxHash": "abc123def456..."
 * }
 * ```
 */
router.post(
  '/:id/execute',
  requireApiKey(ApiScope.ENTERPRISE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params
      const { executionTxHash } = req.body

      if (!executionTxHash) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'executionTxHash is required',
        })
        return
      }

      const input: ExecuteSlashRequestInput = {
        id,
        executionTxHash,
      }

      const slashRequest = await slashService.executeSlashRequest(input)

      res.status(200).json(slashRequest)
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          res.status(404).json({
            error: 'NotFound',
            message: error.message,
          })
          return
        }
        if (error.message.includes('status')) {
          res.status(400).json({
            error: 'InvalidStatusTransition',
            message: error.message,
          })
          return
        }
      }

      console.error('Error executing slash request:', error)
      res.status(500).json({
        error: 'InternalServerError',
        message: 'Failed to execute slash request',
      })
    }
  }
)

export default router
