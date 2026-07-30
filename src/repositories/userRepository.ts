export type UserRole = 'super-admin' | 'admin' | 'verifier' | 'user'

export interface UserRecord {
  id: string
  role: UserRole
  email: string
  tenantId: string
  active?: boolean
}

export interface UserRepository {
  findById(id: string): UserRecord | null
  list(): UserRecord[]
  upsert(user: UserRecord): void
  updateRole(id: string, role: UserRole): void
}

export class InMemoryUserRepository implements UserRepository {
  private store = new Map<string, UserRecord>()

  findById(id: string): UserRecord | null {
    return this.store.get(id) ?? null
  }

  list(): UserRecord[] {
    return [...this.store.values()]
  }

  upsert(user: UserRecord): void {
    this.store.set(user.id, user)
  }

  updateRole(id: string, role: UserRole): void {
    const u = this.store.get(id)
    if (!u) return
    u.role = role
    this.store.set(id, u)
  }

  /** Reset the in-memory store. Intended for tests. */
  _reset(): void {
    this.store.clear()
  }
}

// Export a default shared instance for simple apps and tests. Tests may create
// their own instances when isolation is required.
export const userRepo = new InMemoryUserRepository()
