import { randomUUID } from 'node:crypto'
import type { ArbitrationEntry, ArbitrationInput } from './types.js'

const store = new Map<string, ArbitrationEntry>()

export function resetStore(): void {
  store.clear()
}

export function writeLog(input: ArbitrationInput): ArbitrationEntry {
  if (!input.disputeId || typeof input.disputeId !== 'string') {
    throw new Error('disputeId is required')
  }
  if (!input.arbiter || typeof input.arbiter !== 'string') {
    throw new Error('arbiter is required')
  }
  if (!input.decision || typeof input.decision !== 'string') {
    throw new Error('decision is required')
  }
  if (!input.reasoning || input.reasoning.trim().length === 0) {
    throw new Error('reasoning is required')
  }

  const entry: ArbitrationEntry = {
    id: randomUUID(),
    disputeId: input.disputeId,
    arbiter: input.arbiter,
    decision: input.decision,
    reasoning: input.reasoning,
    timestamp: new Date(),
  }

  store.set(entry.id, entry)
  return entry
}

export function readLog(id: string): ArbitrationEntry | undefined {
  return store.get(id)
}

export function getLogsByDispute(disputeId: string): ArbitrationEntry[] {
  const results: ArbitrationEntry[] = []
  for (const entry of store.values()) {
    if (entry.disputeId === disputeId) {
      results.push(entry)
    }
  }
  return results.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}

export function getLogsByArbiter(arbiter: string): ArbitrationEntry[] {
  const results: ArbitrationEntry[] = []
  for (const entry of store.values()) {
    if (entry.arbiter === arbiter) {
      results.push(entry)
    }
  }
  return results.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}

export function deleteLog(id: string): boolean {
  return store.delete(id)
}
