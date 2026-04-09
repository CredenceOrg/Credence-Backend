declare module 'node-pg-migrate' {
  export type MigrationBuilder = {
    [key: string]: (...args: unknown[]) => unknown
  }

  export type Migration = {
    name?: string
    [key: string]: unknown
  }

  export type RunnerOptions = {
    databaseUrl: string
    dir: string
    migrationsTable?: string
    schema?: string
    createSchema?: boolean
    direction: 'up' | 'down'
    count?: number
    file?: string
    dryRun?: boolean
    verbose?: boolean
    log?: (message: string) => void
    logger?: {
      info?: (message: string) => void
      warn?: (message: string) => void
      error?: (message: string) => void
    }
  }

  export function runner(options: RunnerOptions): Promise<Migration[]>
}