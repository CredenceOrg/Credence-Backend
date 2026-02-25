#!/usr/bin/env node
/**
 * Run Vitest with CWD normalized to uppercase drive (Windows).
 * Fixes "No test suite found" when run from c:\...
 */
const { spawnSync } = require('child_process')

let cwd = process.cwd()
if (process.platform === 'win32' && typeof cwd === 'string' && cwd.length >= 2 && cwd[1] === ':') {
  const drive = cwd[0]
  if (drive >= 'a' && drive <= 'z') {
    cwd = drive.toUpperCase() + cwd.slice(1)
    process.chdir(cwd)
  }
}

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', ...process.argv.slice(2)],
  { stdio: 'inherit', shell: true, cwd }
)
process.exit(result.status ?? 1)
