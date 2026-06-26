import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fetch } from 'node:undici'
import { createClient } from 'redis'
import { Pool } from 'pg'

const execFileAsync = promisify(execFile)
const workspaceRoot = path.resolve(__dirname, '../../')
const composeFile = path.join(workspaceRoot, 'docker-compose.test.yml')

export async function dockerCompose(args: string[]) {
  const { stdout, stderr } = await execFileAsync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: workspaceRoot,
    windowsHide: true,
  })

  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
}

export async function dockerComposeUp() {
  await dockerCompose(['up', '-d', '--remove-orphans'])
}

export async function dockerComposeDown() {
  await dockerCompose(['down', '--volumes', '--remove-orphans'])
}

export async function dockerComposeRestart(service: string) {
  await dockerCompose(['restart', service])
}

export async function dockerComposeStop(service: string) {
  await dockerCompose(['stop', service])
}

export async function dockerComposePause(service: string) {
  await dockerCompose(['pause', service])
}

export async function dockerComposeUnpause(service: string) {
  await dockerCompose(['unpause', service])
}

async function waitFor(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

export async function waitForUrl(url: string, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`Status ${response.status}`)
    } catch (err) {
      lastError = err
    }
    await waitFor(intervalMs)
  }

  throw new Error(`Timeout waiting for URL ${url}: ${String(lastError)}`)
}

export async function waitForDbConnection(connectionString: string, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (err) {
      lastError = err
      await pool.end().catch(() => {})
    }
    await waitFor(intervalMs)
  }

  throw new Error(`Timeout waiting for Postgres at ${connectionString}: ${String(lastError)}`)
}

export async function waitForRedis(connectionString: string, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    const client = createClient({ url: connectionString })
    try {
      await client.connect()
      await client.ping()
      await client.quit()
      return
    } catch (err) {
      lastError = err
      await client.disconnect().catch(() => {})
    }
    await waitFor(intervalMs)
  }

  throw new Error(`Timeout waiting for Redis at ${connectionString}: ${String(lastError)}`)
}

export async function waitForCondition<T>(fn: () => Promise<T>, timeoutMs = 30000, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
    }
    await waitFor(intervalMs)
  }

  throw new Error(`Timeout waiting for condition: ${String(lastError)}`)
}
