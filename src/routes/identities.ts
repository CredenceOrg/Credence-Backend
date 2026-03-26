import { Router } from 'express'
// Import the actual service instance and the error class
import { identityService, ConflictError } from '../services/identityService.js'

const router = Router()

/**
 * GET /api/identities
 * Utility route to view all identities, versions, and current keys.
 */
router.get('/', async (req, res) => {
  try {
    const identities = await identityService.getAllIdentities()
    res.json(identities)
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch identities' })
  }
})

/**
 * PATCH /api/identities/:id
 * Updates an address using Optimistic Locking (#128).
 */
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { address, expectedVersion } = req.body
    
    if (expectedVersion === undefined) {
      return res.status(400).json({ error: 'expectedVersion is required' })
    }

    const updated = await identityService.updateIdentityAddress(id, expectedVersion, address)
    res.json(updated)
  } catch (error) {
    if (error instanceof ConflictError) {
      return res.status(409).json({ error: error.message })
    }
    console.error('Update Error:', error)
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

/**
 * ISSUE #130: POST /api/identities/:id/rotate-key
 * Triggers the secure API key rotation logic.
 */
router.post('/:id/rotate-key', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid Identity ID' })
    }

    const updatedIdentity = await identityService.rotateIdentityApiKey(id)
    
    res.json({
      message: 'API key rotated successfully',
      id: updatedIdentity.id,
      newKey: updatedIdentity.api_key, // Return the key so the user can copy it
      version: updatedIdentity.version
    })
  } catch (error: any) {
    console.error('Rotation Error:', error)
    res.status(400).json({ error: error.message })
  }
})

export default router