import { Router } from 'express'
// Import the actual service instance and the error class
import { identityService, ConflictError } from '../services/identityService.js'

const router = Router()

// Optional: Add a GET route to help us debug and see the current version
router.get('/', async (req, res) => {
  try {
    const identities = await identityService.getAllIdentities()
    res.json(identities)
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch identities' })
  }
})

router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { address, expectedVersion } = req.body
    
    // Ensure we have the data needed
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

export default router