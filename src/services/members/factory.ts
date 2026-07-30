/**
 * @file src/services/members/factory.ts
 *
 * Constructs a ready-to-use MemberService with all dependencies wired up.
 *
 * Importing from this file instead of instantiating inline in each route
 * avoids repeating `new MemberService(new MemberRepository(pool), auditLogService)`
 * across multiple files and makes dependency replacement easy in tests.
 *
 * Usage in route files:
 * ```ts
 * import { MemberService } from '../../services/members/factory.js'
 * const memberService = createMemberService()
 * ```
 */

import { pool } from '../../db/pool.js'
import { auditLogService } from '../audit/index.js'
import { MemberRepository } from '../../repositories/member.repository.js'
import { MemberService } from './service.ts'

export { MemberService }

/**
 * Factory function that constructs a MemberService with the production
 * dependencies (real DB pool, real audit log service).
 *
 * Call once per router instantiation — each router creates its own instance.
 */
export function createMemberService(): MemberService {
  return new MemberService(new MemberRepository(pool), auditLogService)
}