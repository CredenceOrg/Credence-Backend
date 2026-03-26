import Database from 'better-sqlite3';

const db = new Database('src/db/identities.db');

try {
    console.log("Starting Database Migration...");

    // 1. Create the table if it doesn't exist
    db.exec(`
        CREATE TABLE IF NOT EXISTS identities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            address TEXT NOT NULL UNIQUE,
            version INTEGER DEFAULT 1,
            api_key TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log("✅ Table 'identities' is ready.");

    // 2. Check if we need to add the api_key column 
    // (This handles cases where the table existed but was old)
    const tableInfo = db.prepare("PRAGMA table_info(identities)").all();
    const hasApiKey = tableInfo.some(column => column.name === 'api_key');

    if (!hasApiKey) {
        db.exec("ALTER TABLE identities ADD COLUMN api_key TEXT;");
        console.log("✅ Added 'api_key' column to existing table.");
    } else {
        console.log("ℹ️ 'api_key' column already exists.");
    }

    console.log("🚀 Migration complete!");

} catch (err) {
    console.error("❌ Migration failed:", err.message);
} finally {
    db.close();
}