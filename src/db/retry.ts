* } catch (err) {
 *   if (err instanceof ConflictError) {
 *     res.set('Retry-After', String(err.retryAfterSeconds))
 *     return res.status(409).json({ error: err.message, code: err.conflictCode })
 *   }
 * }
 *
