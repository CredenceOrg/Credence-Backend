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
      expect(() => normalizeToUtcIso('invalid-date')).toThrow('Invalid timestamp')
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
      // Sydney DST ends April 5, 2026
      const sydneyInvoices: InvoiceDueDateScheduleItem[] = [
        { invoiceId: 'inv-syd-1', dueAtUtc: '2026-04-04T12:00:00.000Z' }, // Sydney: 2026-04-04 23:00 (AEDT)
        { invoiceId: 'inv-syd-2', dueAtUtc: '2026-04-05T12:00:00.000Z' }, // Sydney: 2026-04-05 22:00 (AEST)
        { invoiceId: 'inv-syd-3', dueAtUtc: '2026-04-06T12:00:00.000Z' }, // Sydney: 2026-04-06 22:00 (AEST)
      ]

      const result = evaluateDueDateActions({
        invoices: sydneyInvoices,
        tenantTimezone: 'Australia/Sydney',
        nowUtc: '2026-04-05T15:00:00.000Z',
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
})
