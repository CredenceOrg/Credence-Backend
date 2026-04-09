import type { Router } from 'express'
import { verificationService } from '../services/verificationService.js'

/**
 * Setup verification routes
 */
export function setupVerificationRoutes(app: any): void {
  /**
   * GET /api/verification/:address
   */
  app.get('/api/verification/:address', (req: any, res: any, next: any) => {
    const { address } = req.params
    const { sign, expiry } = req.query

    // Placeholder data
    const score = 0
    const bondSnapshot = {
      address,
      bondedAmount: '0',
      bondStart: null,
      bondDuration: null,
      active: false,
    }
    const attestationCount = 0

    try {
      const expiryMinutes = expiry ? parseInt(expiry, 10) : undefined

      let proof = verificationService.createProof(
        address,
        score,
        bondSnapshot,
        attestationCount,
        expiryMinutes
      )

      if (sign === 'true') {
        const privateKey = process.env.VERIFICATION_PRIVATE_KEY
        if (!privateKey) {
          throw new AppError('Signing key not configured', ErrorCode.INTERNAL_SERVER_ERROR, 500)
        }
        proof = verificationService.signProof(proof, privateKey)
      }

      res.json(proof)
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/verification/verify
   */
  app.post('/api/verification/verify', (req: any, res: any, next: any) => {
    const { proof, publicKey } = req.body

    if (!proof) {
      throw new ValidationError('Missing proof in request body')
    }

    try {
      const errors: string[] = []

      // Verify hash consistency
      if (!verificationService.verifyProofHash(proof)) {
        errors.push('Hash verification failed')
      }

      // Check expiry
      if (verificationService.isExpired(proof)) {
        errors.push('Proof has expired')
      }

      // Verify signature if present
      if ('signature' in proof && publicKey) {
        if (!verificationService.verifySignedProof(proof, publicKey)) {
          errors.push('Signature verification failed')
        }
      }

      res.json({
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
      })
    } catch (error) {
      next(error)
    }
  })
}
