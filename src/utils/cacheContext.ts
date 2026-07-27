import { AsyncLocalStorage } from 'node:async_hooks'

export interface CacheContextState {
  status: 'HIT' | 'MISS' | 'STALE' | null
}

export const cacheContext = new AsyncLocalStorage<CacheContextState>()

export function recordCacheHit(isStale = false): void {
  const store = cacheContext.getStore()
  if (!store) return

  if (isStale) {
    store.status = 'STALE'
  } else if (store.status !== 'STALE' && store.status !== 'MISS') {
    store.status = 'HIT'
  }
}

export function recordCacheMiss(): void {
  const store = cacheContext.getStore()
  if (!store) return

  if (store.status !== 'STALE') {
    store.status = 'MISS'
  }
}

export function isObjectStale(value: any): boolean {
  if (!value || typeof value !== 'object') return false

  // Check common staleness indicator fields
  if (value.staleness?.fresh === false) return true
  if (value.staleness?.refreshStatus === 'stale') return true
  if (value.refreshStatus === 'stale') return true
  if (value.stale === true) return true
  if (value.status === 'stale') return true

  return false
}
