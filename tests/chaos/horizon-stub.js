import express from 'express'

const app = express()
app.use(express.json())

const records = []

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.post('/__test/add-event', (req, res) => {
  const event = req.body
  if (!event || typeof event !== 'object') {
    return res.status(400).json({ error: 'InvalidEvent', message: 'Expected an event object' })
  }

  if (!event.id || !event.paging_token || event.type !== 'payment') {
    return res.status(400).json({ error: 'InvalidEvent', message: 'Missing required payment event fields' })
  }

  records.push({
    ...event,
    paging_token: String(event.paging_token),
    created_at: event.created_at || new Date().toISOString(),
  })

  res.status(201).json(event)
})

app.post('/__test/reset', (_req, res) => {
  records.length = 0
  res.json({ ok: true })
})

app.get('/operations', (req, res) => {
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
  let filtered = records

  if (cursor && cursor !== 'now') {
    try {
      const cursorValue = BigInt(cursor)
      filtered = records.filter((record) => BigInt(record.paging_token) > cursorValue)
    } catch {
      filtered = records
    }
  }

  const limit = Number(req.query.limit) || 100
  const ordered = filtered.slice().sort((a, b) => BigInt(a.paging_token) - BigInt(b.paging_token))
  const payload = ordered.slice(0, limit)

  res.json({ records: payload, _links: {} })
})

const port = Number(process.env.PORT || 8000)
app.listen(port, () => {
  console.log(`Horizon stub listening on port ${port}`)
})
