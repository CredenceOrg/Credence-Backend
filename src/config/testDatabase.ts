/** Canonical local test database name (matches `docker-compose.test.yml`). */
export const DEFAULT_TEST_DATABASE_NAME = 'credence_test'

/** Default connection URL when `TEST_DATABASE_URL` is unset (`docker-compose.test.yml` port 5433). */
export const DEFAULT_TEST_DATABASE_URL = `postgresql://credence:credence@localhost:5433/${DEFAULT_TEST_DATABASE_NAME}`

/** Resolves the integration-test database URL from the environment or the local default. */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TEST_DATABASE_URL?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_TEST_DATABASE_URL
}
