import { describe, expect, it } from 'vitest'
import {
  evaluateDueDateActions,
  isDstTransitionPeriod,
  normalizeToUtcIso,
  validateTimezone,
  type InvoiceDueDateScheduleItem,
} from './invoiceDueDate.js'

describe('invoiceDueDate — UTC canonicalization & DST boundary regressions', () => {
  describe('normalizeToUtcIso', () => {
    it('canonicalizes ISO strings with Z suffix', () => {
      const input = '2026-03-24T12:34:56.789Z'
      expect(normalizeToUtcIso(input)).toBe('2026-03-24T12:34:56.789Z')
    })

    it('canonicalizes non-Z offset strings to UTC', () => {
      const input = '2026-03-24T14:34:56.789+02:00'
      expect(normalizeToUtcIso(input)).toBe('2026-03-24T12:34:56.789Z')
    })

    it('canonicalizes Date objects to UTC ISO string', () => {
      const date = new Date('2026-06-15T08:00:00.000Z')
      expect(normalizeToUtcIso(date)).toBe('2026-06-15T08:00:00.000Z')
    })

    it('throws error for zone-less timestamps', () => {
      expect(() => normalizeToUtcIso('2026-03-24T10:00:00')).toThrow(
        'Timestamp must include UTC offset or Z suffix',
      )
    })

    it('throws error for invalid timestamp strings', () => {
      // A zone-less string is rejected by the offset guard, before parsing.
      expect(() => normalizeToUtcIso('invalid-date')).toThrow(
        'Timestamp must include UTC offset or Z suffix',
      )
    })

    it('throws error for zone-suffixed but unparseable timestamps', () => {
      // These pass the offset guard and fail at parsing, exercising the
      // distinct 'Invalid timestamp' branch.
      expect(() => normalizeToUtcIso('2026-03-24T99:99:99Z')).toThrow('Invalid timestamp')
      expect(() => normalizeToUtcIso('2026-13-45T00:00:00Z')).toThrow('Invalid timestamp')
    })

    it('rejects zone-less variants that are still unambiguous to a human', () => {
      // Rejected deliberately: accepting these would make the tenant-local day
      // depend on the host machine's timezone rather than an explicit offset.
      expect(() => normalizeToUtcIso('2026-03-24')).toThrow(
        'Timestamp must include UTC offset or Z suffix',
      )
      expect(() => normalizeToUtcIso('2026-03-24T10:00:00z')).toThrow(
        'Timestamp must include UTC offset or Z suffix',
      )
    })

    it('round-trips canonical UTC output', () => {
      const canonical = normalizeToUtcIso('2026-03-24T14:34:56.789+02:00')
      expect(normalizeToUtcIso(canonical)).toBe(canonical)
    })

    it('preserves instant across extreme positive and negative offsets', () => {
      // Same instant expressed three ways must canonicalize identically.
      const expected = '2026-03-24T00:00:00.000Z'
      expect(normalizeToUtcIso('2026-03-24T14:00:00.000+14:00')).toBe(expected)
      expect(normalizeToUtcIso('2026-03-23T12:00:00.000-12:00')).toBe(expected)
      expect(normalizeToUtcIso(expected)).toBe(expected)
    })

    it('throws error for invalid Date instances', () => {
      expect(() => normalizeToUtcIso(new Date(NaN))).toThrow('Invalid Date input')
    })
  })

  describe('validateTimezone', () => {
    it('accepts valid IANA timezones', () => {
      expect(() => validateTimezone('UTC')).not.toThrow()
      expect(() => validateTimezone('America/New_York')).not.toThrow()
      expect(() => validateTimezone('Europe/London')).not.toThrow()
      expect(() => validateTimezone('Asia/Tokyo')).not.toThrow()
      expect(() => validateTimezone('Australia/Sydney')).not.toThrow()
      expect(() => validateTimezone('Pacific/Kiritimati')).not.toThrow()
    })

    it('throws error for invalid timezones', () => {
      expect(() => validateTimezone('Invalid/Timezone')).toThrow('Invalid IANA timezone')
      expect(() => validateTimezone('Mars/Olympus')).toThrow('Invalid IANA timezone')
    })
  })

  describe('isDstTransitionPeriod', () => {
    it('detects spring-forward transition period in US Eastern timezone', () => {
      // US Spring forward transition is on March 8, 2026 around 07:00 UTC (2:00 AM EST -> 3:00 AM EDT)
      const transitionTime = new Date('2026-03-08T07:00:00.000Z')
      expect(isDstTransitionPeriod(transitionTime, 'America/New_York')).toBe(true)
    })

    it('detects fall-back transition period in US Eastern timezone', () => {
      // US Fall back transition is on November 1, 2026 around 06:00 UTC (2:00 AM EDT -> 1:00 AM EST)
      const transitionTime = new Date('2026-11-01T06:00:00.000Z')
      expect(isDstTransitionPeriod(transitionTime, 'America/New_York')).toBe(true)
    })

    it('returns false for steady-state dates outside DST transitions', () => {
      const nonTransitionDate = new Date('2026-06-15T12:00:00.000Z')
      expect(isDstTransitionPeriod(nonTransitionDate, 'America/New_York')).toBe(false)
    })

    it('returns false for UTC timezone as UTC has no DST', () => {
      const date = new Date('2026-03-08T07:00:00.000Z')
      expect(isDstTransitionPeriod(date, 'UTC')).toBe(false)
    })
  })

  describe('evaluateDueDateActions — DST Boundary & Timezone Regressions', () => {
    const sampleInvoices: InvoiceDueDateScheduleItem[] = [
      { invoiceId: 'inv-1', dueAtUtc: '2026-03-08T01:00:00.000Z' },
      { invoiceId: 'inv-2', dueAtUtc: '2026-03-08T15:00:00.000Z' },
      { invoiceId: 'inv-3', dueAtUtc: '2026-03-09T12:00:00.000Z' },
    ]

    it('evaluates due dates correctly during US Spring Forward transition', () => {
      // Current time: 2026-03-08T12:00:00.000Z (EDT day is 2026-03-08)
      const result = evaluateDueDateActions({
        invoices: sampleInvoices,
        tenantTimezone: 'America/New_York',
        nowUtc: '2026-03-08T12:00:00.000Z',
      })

      // In NY, 2026-03-08T01:00:00Z is 2026-03-07 20:00 EST (due March 7)
      // 2026-03-08T15:00:00Z is 2026-03-08 11:00 EDT (due March 8)
      // 2026-03-09T12:00:00Z is 2026-03-09 08:00 EDT (due March 9 - not due yet)
      expect(result.map((i) => i.invoiceId)).toEqual(['inv-1', 'inv-2'])
    })

    it('evaluates due dates correctly during US Fall Back transition', () => {
      const fallInvoices: InvoiceDueDateScheduleItem[] = [
        { invoiceId: 'inv-fall-1', dueAtUtc: '2026-11-01T04:00:00.000Z' }, // 2026-11-01 00:00 EDT
        { invoiceId: 'inv-fall-2', dueAtUtc: '2026-11-01T18:00:00.000Z' }, // 2026-11-01 13:00 EST
        { invoiceId: 'inv-fall-3', dueAtUtc: '2026-11-02T12:00:00.000Z' }, // 2026-11-02 07:00 EST
      ]

      const result = evaluateDueDateActions({
        invoices: fallInvoices,
        tenantTimezone: 'America/New_York',
        nowUtc: '2026-11-01T12:00:00.000Z',
      })

      expect(result.map((i) => i.invoiceId)).toEqual(['inv-fall-1', 'inv-fall-2'])
    })

    it('handles European DST transitions accurately (Europe/Paris)', () => {
      // European DST starts March 29, 2026
      const euroInvoices: InvoiceDueDateScheduleItem[] = [
        { invoiceId: 'inv-eu-1', dueAtUtc: '2026-03-28T22:30:00.000Z' }, // Paris: 2026-03-28 23:30 (CET)
        { invoiceId: 'inv-eu-2', dueAtUtc: '2026-03-29T02:30:00.000Z' }, // Paris: 2026-03-29 04:30 (CEST)
        { invoiceId: 'inv-eu-3', dueAtUtc: '2026-03-30T10:00:00.000Z' }, // Paris: 2026-03-30 12:00 (CEST)
      ]

      const result = evaluateDueDateActions({
        invoices: euroInvoices,
        tenantTimezone: 'Europe/Paris',
        nowUtc: '2026-03-29T12:00:00.000Z',
      })

      expect(result.map((i) => i.invoiceId)).toEqual(['inv-eu-1', 'inv-eu-2'])
    })

    it('handles Southern Hemisphere DST transitions (Australia/Sydney)', () => {
      // Sydney DST ends 2026-04-05 (AEDT -> AEST), moving the UTC offset from
      // +11 to +10.
      const sydneyInvoices: InvoiceDueDateScheduleItem[] = [
        { invoiceId: 'inv-syd-1', dueAtUtc: '2026-04-04T12:00:00.000Z' }, // Sydney: 2026-04-04 23:00 (AEDT)
        { invoiceId: 'inv-syd-2', dueAtUtc: '2026-04-05T12:00:00.000Z' }, // Sydney: 2026-04-05 22:00 (AEST)
        { invoiceId: 'inv-syd-3', dueAtUtc: '2026-04-06T12:00:00.000Z' }, // Sydney: 2026-04-06 22:00 (AEST)
      ]

      // 2026-04-05T15:00:00Z is already 2026-04-06 01:00 in Sydney (+10), so the
      // tenant's current day is 2026-04-06 and every row above is on or before it.
      const result = evaluateDueDateActions({
        invoices: sydneyInvoices,
        tenantTimezone: 'Australia/Sydney',
        nowUtc: '2026-04-05T15:00:00.000Z',
      })

      expect(result.map((i) => i.invoiceId)).toEqual(['inv-syd-1', 'inv-syd-2', 'inv-syd-3'])
    })

    it('does not select the next Sydney day before the tenant reaches it', () => {
      // The boundary pair for the fixture above: one second earlier the Sydney
      // day is still 2026-04-05, so inv-syd-3 (2026-04-06 local) must not fire.
      const sydneyInvoices: InvoiceDueDateScheduleItem[] = [
        { invoiceId: 'inv-syd-1', dueAtUtc: '2026-04-04T12:00:00.000Z' },
        { invoiceId: 'inv-syd-2', dueAtUtc: '2026-04-05T12:00:00.000Z' },
        { invoiceId: 'inv-syd-3', dueAtUtc: '2026-04-06T12:00:00.000Z' },
      ]

      const result = evaluateDueDateActions({
        invoices: sydneyInvoices,
        tenantTimezone: 'Australia/Sydney',
        nowUtc: '2026-04-05T13:59:59.000Z', // 2026-04-05 23:59:59 Sydney
      })

      expect(result.map((i) => i.invoiceId)).toEqual(['inv-syd-1', 'inv-syd-2'])
    })

    it('handles International Date Line edge case (Pacific/Kiritimati UTC+14)', () => {
      const kiritimatiInvoices: InvoiceDueDateScheduleItem[] = [
        { invoiceId: 'inv-kir-1', dueAtUtc: '2026-03-23T11:00:00.000Z' }, // Kiritimati: 2026-03-24 01:00
        { invoiceId: 'inv-kir-2', dueAtUtc: '2026-03-24T12:00:00.000Z' }, // Kiritimati: 2026-03-25 02:00
      ]

      // Current UTC time: 2026-03-23T12:00:00Z -> Kiritimati day is 2026-03-24
      const result = evaluateDueDateActions({
        invoices: kiritimatiInvoices,
        tenantTimezone: 'Pacific/Kiritimati',
        nowUtc: '2026-03-23T12:00:00.000Z',
      })

      expect(result.map((i) => i.invoiceId)).toEqual(['inv-kir-1'])
    })

    it('skips invoices that already have actionTriggeredAtUtc set', () => {
      const invoices: InvoiceDueDateScheduleItem[] = [
        {
          invoiceId: 'inv-triggered',
          dueAtUtc: '2026-03-20T00:00:00.000Z',
          actionTriggeredAtUtc: '2026-03-20T01:00:00.000Z',
        },
        {
          invoiceId: 'inv-pending',
          dueAtUtc: '2026-03-20T00:00:00.000Z',
          actionTriggeredAtUtc: null,
        },
      ]

      const result = evaluateDueDateActions({
        invoices,
        tenantTimezone: 'UTC',
        nowUtc: '2026-03-24T00:00:00.000Z',
      })

      expect(result.map((i) => i.invoiceId)).toEqual(['inv-pending'])
    })

    it('throws error when timezone is invalid', () => {
      expect(() =>
        evaluateDueDateActions({
          invoices: sampleInvoices,
          tenantTimezone: 'Bad/Timezone',
          nowUtc: '2026-03-24T00:00:00.000Z',
        }),
      ).toThrow('Invalid IANA timezone')
    })
  })

  describe('boundary and recovery coverage', () => {
    describe('day-boundary eligibility', () => {
      it('selects an invoice due at the exact current instant', () => {
        const result = evaluateDueDateActions({
          invoices: [{ invoiceId: 'exact', dueAtUtc: '2026-03-24T12:00:00.000Z' }],
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T12:00:00.000Z',
        })
        expect(result.map((i) => i.invoiceId)).toEqual(['exact'])
      })

      it('selects the last millisecond of the tenant day but not the next one', () => {
        const invoices: InvoiceDueDateScheduleItem[] = [
          { invoiceId: 'last-ms', dueAtUtc: '2026-03-24T23:59:59.999Z' },
          { invoiceId: 'next-day', dueAtUtc: '2026-03-25T00:00:00.000Z' },
        ]
        const result = evaluateDueDateActions({
          invoices,
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T23:59:59.999Z',
        })
        expect(result.map((i) => i.invoiceId)).toEqual(['last-ms'])
      })

      it('treats eligibility as day-granular, not instant-granular', () => {
        // Due later the same tenant day: still selected. This is the documented
        // day-comparison rule and is why an invoice never fires "early".
        const result = evaluateDueDateActions({
          invoices: [{ invoiceId: 'later-today', dueAtUtc: '2026-03-24T22:00:00.000Z' }],
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        expect(result.map((i) => i.invoiceId)).toEqual(['later-today'])
      })

      it('selects a long-overdue invoice (far past boundary)', () => {
        const result = evaluateDueDateActions({
          invoices: [{ invoiceId: 'ancient', dueAtUtc: '2020-01-01T00:00:00.000Z' }],
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        expect(result.map((i) => i.invoiceId)).toEqual(['ancient'])
      })

      it('handles leap day and year rollover without drifting', () => {
        const invoices: InvoiceDueDateScheduleItem[] = [
          { invoiceId: 'leap', dueAtUtc: '2024-02-29T12:00:00.000Z' },
          { invoiceId: 'new-year', dueAtUtc: '2026-01-01T00:00:00.000Z' },
        ]
        const result = evaluateDueDateActions({
          invoices,
          tenantTimezone: 'UTC',
          nowUtc: '2026-01-01T00:00:00.000Z',
        })
        expect(result.map((i) => i.invoiceId)).toEqual(['leap', 'new-year'])
      })

      it('applies the tenant day rule across the +14 and -12 extremes', () => {
        // Kiritimati (UTC+14) is already on 2026-03-24 at 12:00Z.
        const ahead = evaluateDueDateActions({
          invoices: [
            { invoiceId: 'today-ahead', dueAtUtc: '2026-03-23T12:00:00.000Z' },
            { invoiceId: 'tomorrow-ahead', dueAtUtc: '2026-03-25T00:00:00.000Z' },
          ],
          tenantTimezone: 'Pacific/Kiritimati',
          nowUtc: '2026-03-23T12:00:00.000Z',
        })
        expect(ahead.map((i) => i.invoiceId)).toEqual(['today-ahead'])

        // Etc/GMT+12 is still on 2026-03-23 at 12:00Z (00:00 local).
        const behind = evaluateDueDateActions({
          invoices: [
            { invoiceId: 'yesterday-behind', dueAtUtc: '2026-03-22T00:00:00.000Z' },
            { invoiceId: 'today-behind', dueAtUtc: '2026-03-23T00:00:00.000Z' },
          ],
          tenantTimezone: 'Etc/GMT+12',
          nowUtc: '2026-03-23T12:00:00.000Z',
        })
        expect(behind.map((i) => i.invoiceId)).toEqual(['yesterday-behind', 'today-behind'])
      })
    })

    describe('duplicate and empty input', () => {
      it('selects a duplicated invoiceId at most once', () => {
        // A repeated row must not produce a second selection: callers trigger
        // side effects per returned row, so a duplicate would double-fire.
        const result = evaluateDueDateActions({
          invoices: [
            { invoiceId: 'dup', dueAtUtc: '2026-03-23T00:00:00.000Z' },
            { invoiceId: 'dup', dueAtUtc: '2026-03-23T00:00:00.000Z' },
          ],
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        expect(result).toHaveLength(1)
        expect(result.map((i) => i.invoiceId)).toEqual(['dup'])
      })

      it('deduplicates regardless of dueAtUtc variation on the duplicate row', () => {
        const result = evaluateDueDateActions({
          invoices: [
            { invoiceId: 'dup', dueAtUtc: '2026-03-23T00:00:00.000Z' },
            { invoiceId: 'dup', dueAtUtc: '2026-03-20T00:00:00.000Z' },
          ],
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        expect(result).toHaveLength(1)
      })

      it('returns an empty array for an empty input', () => {
        const result = evaluateDueDateActions({
          invoices: [],
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        expect(result).toEqual([])
      })

      it('treats actionTriggeredAtUtc of null as not yet triggered', () => {
        const result = evaluateDueDateActions({
          invoices: [{ invoiceId: 'null-ok', dueAtUtc: '2026-03-23T00:00:00.000Z', actionTriggeredAtUtc: null }],
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        expect(result.map((i) => i.invoiceId)).toEqual(['null-ok'])
      })

      it('does not mutate the caller input array or its items', () => {
        const invoices: InvoiceDueDateScheduleItem[] = [
          { invoiceId: 'a', dueAtUtc: '2026-03-23T00:00:00.000Z' },
          { invoiceId: 'b', dueAtUtc: '2026-03-24T00:00:00.000Z' },
        ]
        const snapshot = JSON.stringify(invoices)

        const result = evaluateDueDateActions({
          invoices,
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        result.length = 0

        expect(JSON.stringify(invoices)).toBe(snapshot)
        expect(invoices).toHaveLength(2)
      })

      it('preserves input order in the result', () => {
        const result = evaluateDueDateActions({
          invoices: [
            { invoiceId: 'third', dueAtUtc: '2026-03-23T00:00:00.000Z' },
            { invoiceId: 'first', dueAtUtc: '2026-03-21T00:00:00.000Z' },
            { invoiceId: 'second', dueAtUtc: '2026-03-22T00:00:00.000Z' },
          ],
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        expect(result.map((i) => i.invoiceId)).toEqual(['third', 'first', 'second'])
      })
    })

    describe('invalid input rejection', () => {
      it('rejects an invalid timezone before evaluating any invoice', () => {
        expect(() =>
          evaluateDueDateActions({
            invoices: [{ invoiceId: 'x', dueAtUtc: '2026-03-23T00:00:00.000Z' }],
            tenantTimezone: 'Not/AZone',
            nowUtc: '2026-03-24T00:00:00.000Z',
          }),
        ).toThrow('Invalid IANA timezone')
      })

      it('rejects a zone-less nowUtc', () => {
        expect(() =>
          evaluateDueDateActions({
            invoices: [],
            tenantTimezone: 'UTC',
            nowUtc: '2026-03-24T00:00:00',
          }),
        ).toThrow('Timestamp must include UTC offset or Z suffix')
      })

      it('rejects a zone-less dueAtUtc rather than guessing an offset', () => {
        expect(() =>
          evaluateDueDateActions({
            invoices: [{ invoiceId: 'x', dueAtUtc: '2026-03-23T00:00:00' }],
            tenantTimezone: 'UTC',
            nowUtc: '2026-03-24T00:00:00.000Z',
          }),
        ).toThrow('Timestamp must include UTC offset or Z suffix')
      })

      it('rejects an invalid Date instance for nowUtc', () => {
        expect(() =>
          evaluateDueDateActions({
            invoices: [],
            tenantTimezone: 'UTC',
            nowUtc: new Date(NaN),
          }),
        ).toThrow('Invalid Date input')
      })

      it('surfaces the offending invoice id when a dueAtUtc is malformed', () => {
        // The thrown message names the timestamp so the caller can log a
        // diagnosable pointer to the bad row.
        let caught = ''
        try {
          evaluateDueDateActions({
            invoices: [{ invoiceId: 'bad-row', dueAtUtc: '2026-13-45T00:00:00Z' }],
            tenantTimezone: 'UTC',
            nowUtc: '2026-03-24T00:00:00.000Z',
          })
        } catch (error) {
          caught = error instanceof Error ? error.message : ''
        }
        expect(caught).toContain('Invalid timestamp')
        expect(caught).toContain('2026-13-45T00:00:00Z')
      })
    })

    describe('DST transition detection', () => {
      it('flags only a bounded window around a transition, not the whole day', () => {
        // Detection is diagnostic only, but it must not flag steady state,
        // otherwise the signal becomes useless.
        expect(isDstTransitionPeriod(new Date('2026-06-15T12:00:00.000Z'), 'America/New_York')).toBe(false)
        expect(isDstTransitionPeriod(new Date('2026-01-15T12:00:00.000Z'), 'America/New_York')).toBe(false)
      })

      it('flags the spring-forward instant in both hemispheres', () => {
        expect(isDstTransitionPeriod(new Date('2026-03-08T07:00:00.000Z'), 'America/New_York')).toBe(true)
        expect(isDstTransitionPeriod(new Date('2026-03-29T01:00:00.000Z'), 'Europe/Paris')).toBe(true)
        expect(isDstTransitionPeriod(new Date('2026-10-03T16:00:00.000Z'), 'Australia/Sydney')).toBe(true)
      })

      it('flags the fall-back instant in both hemispheres', () => {
        expect(isDstTransitionPeriod(new Date('2026-11-01T06:00:00.000Z'), 'America/New_York')).toBe(true)
        expect(isDstTransitionPeriod(new Date('2026-10-25T01:00:00.000Z'), 'Europe/Paris')).toBe(true)
        expect(isDstTransitionPeriod(new Date('2026-04-04T16:00:00.000Z'), 'Australia/Sydney')).toBe(true)
      })

      it('returns false rather than throwing for an invalid timezone', () => {
        expect(isDstTransitionPeriod(new Date('2026-03-08T07:00:00.000Z'), 'Bad/Zone')).toBe(false)
      })

      it('selects correctly across a spring-forward day boundary', () => {
        // 2026-03-08T02:00 EST does not exist; the day must still resolve.
        const result = evaluateDueDateActions({
          invoices: [
            { invoiceId: 'before', dueAtUtc: '2026-03-08T04:59:59.000Z' }, // 2026-03-07 23:59:59 EST
            { invoiceId: 'after', dueAtUtc: '2026-03-08T05:00:00.000Z' },  // 2026-03-08 01:00 EDT
            { invoiceId: 'later', dueAtUtc: '2026-03-09T05:00:00.000Z' },
          ],
          tenantTimezone: 'America/New_York',
          nowUtc: '2026-03-08T12:00:00.000Z',
        })
        expect(result.map((i) => i.invoiceId)).toEqual(['before', 'after'])
      })

      it('does not fire an invoice a second early across a spring-forward gap', () => {
        // 2026-03-09 in New York begins at 04:00Z (midnight EDT, after the
        // skipped 02:00 hour). One second earlier the tenant is still on
        // 2026-03-08, so a 2026-03-09-local invoice must not fire yet.
        const invoice = { invoiceId: 'next-local-day', dueAtUtc: '2026-03-09T05:00:00.000Z' }

        const before = evaluateDueDateActions({
          invoices: [invoice],
          tenantTimezone: 'America/New_York',
          nowUtc: '2026-03-09T03:59:59.000Z', // 2026-03-08 23:59:59 EDT
        })
        expect(before).toEqual([])

        const after = evaluateDueDateActions({
          invoices: [invoice],
          tenantTimezone: 'America/New_York',
          nowUtc: '2026-03-09T04:00:00.000Z', // 2026-03-09 00:00:00 EDT
        })
        expect(after.map((i) => i.invoiceId)).toEqual(['next-local-day'])
      })
    })

    describe('determinism and recovery', () => {
      it('returns identical results for repeated evaluation of the same input', () => {
        const input = {
          invoices: [
            { invoiceId: 'a', dueAtUtc: '2026-03-23T00:00:00.000Z' },
            { invoiceId: 'b', dueAtUtc: '2026-03-24T12:00:00.000Z' },
            { invoiceId: 'c', dueAtUtc: '2026-03-25T00:00:00.000Z' },
          ],
          tenantTimezone: 'America/New_York',
          nowUtc: '2026-03-24T18:00:00.000Z',
        }
        const first = evaluateDueDateActions(input)
        const second = evaluateDueDateActions(input)
        expect(second).toEqual(first)
      })

      it('defaults nowUtc to the current time when omitted', () => {
        const longOverdue = evaluateDueDateActions({
          invoices: [{ invoiceId: 'old', dueAtUtc: '2020-01-01T00:00:00.000Z' }],
          tenantTimezone: 'UTC',
        })
        expect(longOverdue.map((i) => i.invoiceId)).toEqual(['old'])

        const future = evaluateDueDateActions({
          invoices: [{ invoiceId: 'future', dueAtUtc: '2999-01-01T00:00:00.000Z' }],
          tenantTimezone: 'UTC',
        })
        expect(future).toEqual([])
      })

      it('accepts Date objects for nowUtc and dueAtUtc interchangeably with ISO strings', () => {
        const viaString = evaluateDueDateActions({
          invoices: [{ invoiceId: 'x', dueAtUtc: '2026-03-23T00:00:00.000Z' }],
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        const viaDate = evaluateDueDateActions({
          invoices: [{ invoiceId: 'x', dueAtUtc: new Date('2026-03-23T00:00:00.000Z') }],
          tenantTimezone: 'UTC',
          nowUtc: new Date('2026-03-24T00:00:00.000Z'),
        })
        expect(viaDate.map((i) => i.invoiceId)).toEqual(viaString.map((i) => i.invoiceId))
      })

      it('treats an equal offset instant and its UTC equivalent identically', () => {
        const invoices = [{ invoiceId: 'x', dueAtUtc: '2026-03-23T00:00:00.000Z' }]
        const viaOffset = evaluateDueDateActions({
          invoices,
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T02:00:00.000+02:00',
        })
        const viaUtc = evaluateDueDateActions({
          invoices,
          tenantTimezone: 'UTC',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        expect(viaOffset.map((i) => i.invoiceId)).toEqual(viaUtc.map((i) => i.invoiceId))
      })

      it('evaluates a large batch within a sane time budget', () => {
        const invoices: InvoiceDueDateScheduleItem[] = Array.from({ length: 2000 }, (_, i) => ({
          invoiceId: `bulk-${i}`,
          dueAtUtc: '2026-03-23T00:00:00.000Z',
        }))

        const started = Date.now()
        const result = evaluateDueDateActions({
          invoices,
          tenantTimezone: 'America/New_York',
          nowUtc: '2026-03-24T00:00:00.000Z',
        })
        const elapsed = Date.now() - started

        expect(result).toHaveLength(2000)
        // Generous ceiling: guards against a reintroduced per-row Intl hotspot,
        // not a performance SLA.
        expect(elapsed).toBeLessThan(1000)
      })
    })
  })

})
