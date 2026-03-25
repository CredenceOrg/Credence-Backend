import Database from 'better-sqlite3';

const db = new Database('src/db/identities.db');

// Ensure the DLQ table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    message_type TEXT,
    payload TEXT,
    error_message TEXT,
    failed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

export const queueService = {
  /**
   * Routes failed payloads to the DLQ table with diagnostics.
   */
  async moveToDLQ(jobId: string, type: string, payload: any, error: string) {
    const stmt = db.prepare(`
      INSERT INTO dead_letter_queue (job_id, message_type, payload, error_message)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(jobId, type, JSON.stringify(payload), error);
    console.error(`[DLQ] Job ${jobId} moved to DLQ. Error: ${error}`);
  }
};