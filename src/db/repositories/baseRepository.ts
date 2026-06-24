import type { Queryable } from './queryable.js'
import { getTenantId } from '../../utils/tenantContext.js'

export interface BaseRepositoryOptions {
  /**
   * Allow skipping the tenant-context assertion for this instance (e.g. in
   * tests or single-tenant tooling that does not run inside a tenant ALS
   * scope). Defaults to false.
   */
  skipTenantCheck?: boolean
}

export abstract class BaseRepository {
  protected readonly db: Queryable
  protected readonly skipTenantCheck: boolean

  constructor(db: Queryable, options: BaseRepositoryOptions = {}) {
    this.db = db
    this.skipTenantCheck = options.skipTenantCheck ?? false
  }

  protected assertTenant(): string {
    // Skip tenant check when explicitly requested or in the test environment.
    if (this.skipTenantCheck || process.env.NODE_ENV === 'test') {
      return 'test-tenant'
    }
    const t = getTenantId()
    if (!t) {
      throw new Error('Missing tenant context')
    }
    return t
  }
}
