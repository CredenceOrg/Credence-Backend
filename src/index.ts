import express from 'express'
import { createHealthRouter } from './routes/health.js'
import { createDefaultProbes } from './services/health/probes.js'
import { TrustService } from './services/trust/index.js'
import { BondService } from './services/bond/index.js'

const app = express()
const PORT = process.env.PORT ?? 3000

app.use(express.json())

const healthProbes = createDefaultProbes()
app.use('/api/health', createHealthRouter(healthProbes))

const trustService = new TrustService()
const bondService = new BondService()

// Validate Ethereum address format
function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address)
}

app.get('/api/trust/:address', async (req, res) => {
  const { address } = req.params

  if (!isValidAddress(address)) {
    return res.status(400).json({
      error: 'Invalid address format. Expected an Ethereum address: 0x followed by 40 hex characters.'
    })
  }

  try {
    const trustScore = await trustService.getTrustScore(address)
    if (!trustScore) {
      return res.status(404).json({
        error: `No identity record found for address ${address}.`
      })
    }
    res.json(trustScore)
  } catch (error) {
    console.error('Error fetching trust score:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/bond/:address', async (req, res) => {
  const { address } = req.params

  if (!isValidAddress(address)) {
    return res.status(400).json({
      error: 'Invalid address format. Expected an Ethereum address: 0x followed by 40 hex characters.'
    })
  }

  try {
    const bondStatus = await bondService.getBondStatus(address)
    if (!bondStatus) {
      // Return zeroed status for unknown addresses
      return res.json({
        address,
        bondedAmount: '0',
        bondStart: null,
        bondDuration: null,
        active: false,
      })
    }
    res.json(bondStatus)
  } catch (error) {
    console.error('Error fetching bond status:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Bulk verification endpoint (Enterprise)
app.use('/api/bulk', bulkRouter)

// Only start server if not in test environment
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Credence API listening on http://localhost:${PORT}`)
  })
}

export default app
