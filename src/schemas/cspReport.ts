import { z } from './openapi.js'

export const cspReportDetailsSchema = z.object({
  'document-uri': z.string(),
  'referrer': z.string().optional(),
  'blocked-uri': z.string().optional(),
  'violated-directive': z.string().optional(),
  'effective-directive': z.string().optional(),
  'original-policy': z.string().optional(),
  'disposition': z.string().optional(),
  'status-code': z.number().int().optional(),
  'script-sample': z.string().optional(),
}).openapi('CspReportDetails')

export const cspReportSchema = z.object({
  'csp-report': cspReportDetailsSchema,
}).openapi('CspReport')

export type CspReport = z.infer<typeof cspReportSchema>
