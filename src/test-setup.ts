/**
 * Vitest setup: normalize process.cwd() to uppercase drive on Windows
 * so Vitest's path handling finds test suites (avoids "No test suite found").
 */
const cwd = process.cwd()
if (typeof cwd === 'string' && cwd.length >= 2 && cwd[1] === ':') {
  const drive = cwd[0]
  if (drive >= 'a' && drive <= 'z') {
    process.chdir((drive.toUpperCase() as string) + cwd.slice(1))
  }
}
