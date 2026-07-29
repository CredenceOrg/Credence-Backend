import { z } from './openapi.js'

export const paginationLinksSchema = z.object({
  self: z.string().url().openapi({
    description: 'Link to the current page',
    example: 'https://api.credence.org/v1/resource?page=2&limit=20',
  }),
  first: z.string().url().optional().openapi({
    description: 'Link to the first page',
    example: 'https://api.credence.org/v1/resource?page=1&limit=20',
  }),
  prev: z.string().url().optional().openapi({
    description: 'Link to the previous page',
    example: 'https://api.credence.org/v1/resource?page=1&limit=20',
  }),
  next: z.string().url().optional().openapi({
    description: 'Link to the next page',
    example: 'https://api.credence.org/v1/resource?page=3&limit=20',
  }),
  last: z.string().url().optional().openapi({
    description: 'Link to the last page',
    example: 'https://api.credence.org/v1/resource?page=5&limit=20',
  }),
}).openapi('PaginationLinks')

export type PaginationLinks = z.infer<typeof paginationLinksSchema>
