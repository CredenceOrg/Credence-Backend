import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  DlqReasonCode,
  DlqRouter,
  validateMessage,
  validateAndRoute,
  type DlqSink,
  type ValidationResult,
} from '../messageValidator.js'

// ── Test fixtures ─────────────────────────────────────────────────────────────

/** Simple schema used across all test groups. */
const personSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  age: z.number().int().positive('Age must be a positive integer'),
})

type Person = z.infer<typeof personSchema>

/** Creates an in-memory DLQ sink that records every captured message. */
function makeSink(): DlqSink & { captured: Array<{ type: string; data: unknown; reason: string }> } {
  const captured: Array<{ type: string; data: unknown; reason: string }> = []
  return {
    captured,
    async captureFailure(type, data, reason) {
      captured.push({ type, data, reason })
    },
  }
}

// ── validateMessage ───────────────────────────────────────────────────────────

describe('validateMessage', () => {
  it('returns valid=true with the parsed data for a conforming payload', () => {
    const result = validateMessage(personSchema, { name: 'Alice', age: 30 })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data).toEqual({ name: 'Alice', age: 30 })
    }
  })

  it('returns valid=false with SCHEMA_VALIDATION_FAILED for a missing required field', () => {
    const result: ValidationResult<Person> = validateMessage(personSchema, { age: 30 })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reasonCode).toBe(DlqReasonCode.SCHEMA_VALIDATION_FAILED)
      expect(result.detail).toContain('name')
    }
  })

  it('returns valid=false for a completely wrong payload type (null)', () => {
    const result = validateMessage(personSchema, null)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reasonCode).toBe(DlqReasonCode.SCHEMA_VALIDATION_FAILED)
    }
  })

  it('returns valid=false for an array instead of an object', () => {
    expect(validateMessage(personSchema, []).valid).toBe(false)
  })

  it('returns valid=false for a primitive string', () => {
    expect(validateMessage(personSchema, 'not-an-object').valid).toBe(false)
  })

  it('includes the failing field path in the error detail', () => {
    const result = validateMessage(personSchema, { name: '', age: 25 })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.detail).toContain('name')
    }
  })

  it('includes all failing field paths when multiple fields are invalid', () => {
    const result = validateMessage(personSchema, { name: '', age: -5 })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      // Both field names should appear in the semicolon-separated detail string
      expect(result.detail).toContain('name')
      expect(result.detail).toContain('age')
    }
  })

  it('detail falls back to "(root)" for top-level type errors', () => {
    const strSchema = z.string()
    const result = validateMessage(strSchema, 42)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.detail).toContain('(root)')
    }
  })

  it('does not throw for any input type', () => {
    const inputs: unknown[] = [undefined, null, 0, '', [], {}, Symbol('x'), () => {}]
    for (const input of inputs) {
      expect(() => validateMessage(personSchema, input)).not.toThrow()
    }
  })
})

// ── DlqRouter ─────────────────────────────────────────────────────────────────

describe('DlqRouter', () => {
  it('routes to the sink with a structured [CODE] prefix', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)

    await router.route('attestation', { id: 'bad' }, DlqReasonCode.SCHEMA_VALIDATION_FAILED, 'type: required')

    expect(sink.captured).toHaveLength(1)
    expect(sink.captured[0].type).toBe('attestation')
    expect(sink.captured[0].reason).toBe('[SCHEMA_VALIDATION_FAILED] type: required')
  })

  it('stores the raw payload without modification', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)
    const raw = { nested: { value: 42 }, list: [1, 2] }

    await router.route('withdrawal', raw, DlqReasonCode.PROCESSING_ERROR, 'DB timeout')

    expect(sink.captured[0].data).toEqual(raw)
  })

  it('routes a null payload without throwing', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)

    await expect(
      router.route('bond', null, DlqReasonCode.UNKNOWN_MESSAGE_TYPE, 'no handler'),
    ).resolves.toBeUndefined()

    expect(sink.captured[0].data).toBeNull()
  })

  it('uses every defined DlqReasonCode as a prefix', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)

    for (const code of Object.values(DlqReasonCode)) {
      await router.route('test', {}, code, 'detail')
    }

    const reasons = sink.captured.map((c) => c.reason)
    for (const code of Object.values(DlqReasonCode)) {
      expect(reasons).toContain(`[${code}] detail`)
    }
  })

  it('propagates sink errors to the caller', async () => {
    const failingSink: DlqSink = {
      async captureFailure() {
        throw new Error('sink unavailable')
      },
    }
    const router = new DlqRouter(failingSink)

    await expect(
      router.route('test', {}, DlqReasonCode.PROCESSING_ERROR, 'boom'),
    ).rejects.toThrow('sink unavailable')
  })
})

// ── validateAndRoute ──────────────────────────────────────────────────────────

describe('validateAndRoute', () => {
  it('returns valid=true without touching the sink for a conforming payload', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)

    const result = await validateAndRoute(personSchema, 'person', { name: 'Bob', age: 25 }, router)

    expect(result.valid).toBe(true)
    expect(sink.captured).toHaveLength(0)
  })

  it('returns valid=false and routes to DLQ for a non-conforming payload', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)

    const result = await validateAndRoute(personSchema, 'person', { name: '' }, router)

    expect(result.valid).toBe(false)
    expect(sink.captured).toHaveLength(1)
    expect(sink.captured[0].type).toBe('person')
    expect(sink.captured[0].reason).toContain('[SCHEMA_VALIDATION_FAILED]')
  })

  it('persists the original raw payload in the DLQ entry', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)
    const raw = { totally: 'wrong' }

    await validateAndRoute(personSchema, 'person', raw, router)

    expect(sink.captured[0].data).toEqual(raw)
  })

  it('routes exactly once per invalid message (no double-capture)', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)

    await validateAndRoute(personSchema, 'person', { bad: true }, router)

    expect(sink.captured).toHaveLength(1)
  })

  it('routes null payloads to the DLQ', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)

    const result = await validateAndRoute(personSchema, 'person', null, router)

    expect(result.valid).toBe(false)
    expect(sink.captured).toHaveLength(1)
  })

  it('valid result carries the fully-typed parsed data', async () => {
    const sink = makeSink()
    const router = new DlqRouter(sink)

    const result = await validateAndRoute(personSchema, 'person', { name: 'Carol', age: 28 }, router)

    expect(result.valid).toBe(true)
    if (result.valid) {
      // TypeScript should narrow this to `Person`
      const person: Person = result.data
      expect(person.name).toBe('Carol')
      expect(person.age).toBe(28)
    }
  })

  it('is composable with attestationEventSchema from the schemas module', async () => {
    const { attestationEventSchema } = await import('../../schemas/queue.js')
    const sink = makeSink()
    const router = new DlqRouter(sink)

    const badEvent = { id: '', type: 'unknown', weight: 200 }
    const result = await validateAndRoute(attestationEventSchema, 'attestation', badEvent, router)

    expect(result.valid).toBe(false)
    expect(sink.captured[0].type).toBe('attestation')
  })
})

// ── DlqReasonCode ─────────────────────────────────────────────────────────────

describe('DlqReasonCode', () => {
  it('exposes all expected reason codes', () => {
    expect(DlqReasonCode.SCHEMA_VALIDATION_FAILED).toBe('SCHEMA_VALIDATION_FAILED')
    expect(DlqReasonCode.UNKNOWN_MESSAGE_TYPE).toBe('UNKNOWN_MESSAGE_TYPE')
    expect(DlqReasonCode.PROCESSING_ERROR).toBe('PROCESSING_ERROR')
    expect(DlqReasonCode.MAX_RETRIES_EXCEEDED).toBe('MAX_RETRIES_EXCEEDED')
  })
})
