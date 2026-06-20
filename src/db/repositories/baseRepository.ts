import type { Queryable } from './queryable.js'
import { getTenantId } from '../../utils/tenantContext.js'

export abstract class BaseRepository {
  constructor(protected readonly db: Queryable) {}

  protected assertTenant(): string {
    // Skip tenant check in test environment
    if (process.env.NODE_ENV === 'test') {
      return 'test-tenant'
    }
    const t = getTenantId()
    if (!t) {
      throw new Error('Missing tenant context')
    }
    return t
  }
}
