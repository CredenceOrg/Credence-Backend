import type { Queryable } from './queryable.js'
import { getTenantId } from '../../utils/tenantContext.js'

export interface BaseRepositoryOptions {
  /** @deprecated no longer supported */
  skipTenantCheck?: boolean
}

export abstract class BaseRepository {
  protected readonly db: Queryable
  protected readonly skipTenantCheck: boolean

  constructor(db: Queryable, _options: BaseRepositoryOptions = {}) {
    this.db = db
    this.skipTenantCheck = _options.skipTenantCheck ?? false
  }

  protected assertTenant(): string {
    const t = getTenantId()
    if (!t) throw new Error('Missing tenant context')
    return t
  }
}
