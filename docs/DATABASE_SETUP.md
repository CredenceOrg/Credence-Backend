# Database Setup Guide

## Prerequisites

- PostgreSQL 12 or higher
- Node.js 18+
- npm or pnpm

## Quick Start

### 1. Install PostgreSQL

**macOS (Homebrew):**
```bash
brew install postgresql@15
brew services start postgresql@15
```

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install postgresql postgresql-contrib
sudo systemctl start postgresql
```

**Windows:**
Download and install from [postgresql.org](https://www.postgresql.org/download/windows/)

### 2. Create Database

```bash
# Connect to PostgreSQL
psql postgres

# Create database
CREATE DATABASE credence_dev;

# Create user (optional)
CREATE USER credence_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE credence_dev TO credence_user;

# Exit
\q
```

### 3. Set Environment Variable

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://credence_user:your_password@localhost:5432/credence_dev
```

Or for default PostgreSQL user:

```env
DATABASE_URL=postgresql://localhost:5432/credence_dev
```

### 4. Run Migrations

```bash
# Run the schema migration
psql $DATABASE_URL < src/db/migrations/001_create_slash_requests.sql

# Or manually
psql credence_dev < src/db/migrations/001_create_slash_requests.sql
```

### 5. Verify Setup

```bash
# Connect to database
psql $DATABASE_URL

# List tables
\dt

# Describe slash_requests table
\d slash_requests

# Exit
\q
```

## Database Schema

### Tables

#### slash_requests

Stores slash requests for the governance system.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY | Unique identifier |
| target_address | VARCHAR(56) | NOT NULL | Stellar address to slash |
| amount | DECIMAL(20,7) | NOT NULL, > 0 | Amount to slash (XLM) |
| reason | TEXT | NOT NULL, ≥ 10 chars | Detailed reason |
| evidence_ref | TEXT | NOT NULL | Evidence reference |
| status | slash_status | NOT NULL, DEFAULT 'pending' | Current status |
| submitted_by | VARCHAR(56) | NOT NULL | Submitter's address |
| submitted_at | TIMESTAMP | NOT NULL, DEFAULT NOW() | Submission time |
| reviewed_by | VARCHAR(56) | NULL | Reviewer's address |
| reviewed_at | TIMESTAMP | NULL | Review time |
| review_notes | TEXT | NULL | Review notes |
| executed_at | TIMESTAMP | NULL | Execution time |
| execution_tx_hash | VARCHAR(64) | NULL | Transaction hash |
| created_at | TIMESTAMP | NOT NULL, DEFAULT NOW() | Creation time |
| updated_at | TIMESTAMP | NOT NULL, DEFAULT NOW() | Last update time |

### Enums

#### slash_status

- `pending` - Awaiting review
- `approved` - Approved for execution
- `rejected` - Rejected by reviewer
- `executed` - Successfully executed

#### user_role

- `verifier` - Can submit slash requests
- `admin` - Can review and execute
- `user` - Regular user

### Indexes

- `idx_slash_requests_status` - Query by status
- `idx_slash_requests_target` - Query by target address
- `idx_slash_requests_submitter` - Query by submitter
- `idx_slash_requests_created_at` - Sort by creation date

### Constraints

- Valid Stellar address format (G + 55 base32 characters)
- Amount must be positive
- Reason must be at least 10 characters
- Status transitions enforced by application logic

## Testing

### Test Database

Create a separate test database:

```bash
psql postgres
CREATE DATABASE credence_test;
\q
```

Set test environment variable:

```env
TEST_DATABASE_URL=postgresql://localhost:5432/credence_test
```

Run migrations on test database:

```bash
psql $TEST_DATABASE_URL < src/db/migrations/001_create_slash_requests.sql
```

### Run Tests

```bash
# Run all tests
npm test

# Run slash-specific tests
npm test src/services/slash
npm test src/routes/slash.test.ts

# Run with coverage
npm run test:coverage
```

## Maintenance

### Backup Database

```bash
pg_dump credence_dev > backup_$(date +%Y%m%d).sql
```

### Restore Database

```bash
psql credence_dev < backup_20240225.sql
```

### Reset Database

```bash
# Drop and recreate
psql postgres
DROP DATABASE credence_dev;
CREATE DATABASE credence_dev;
\q

# Run migrations
psql credence_dev < src/db/migrations/001_create_slash_requests.sql
```

### View Logs

```bash
# PostgreSQL logs location varies by OS
# macOS (Homebrew):
tail -f /usr/local/var/log/postgresql@15.log

# Ubuntu:
sudo tail -f /var/log/postgresql/postgresql-15-main.log
```

## Production Considerations

### Connection Pooling

The application uses `pg` connection pooling with these defaults:

- Max connections: 20
- Idle timeout: 30 seconds
- Connection timeout: 2 seconds

Adjust in `src/db/pool.ts` based on your needs.

### Performance Tuning

```sql
-- Analyze tables for query optimization
ANALYZE slash_requests;

-- View query performance
EXPLAIN ANALYZE SELECT * FROM slash_requests WHERE status = 'pending';

-- Monitor slow queries
SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;
```

### Security

1. **Use SSL in production:**
   ```env
   DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
   ```

2. **Restrict database user permissions:**
   ```sql
   REVOKE ALL ON DATABASE credence_prod FROM PUBLIC;
   GRANT CONNECT ON DATABASE credence_prod TO credence_user;
   GRANT SELECT, INSERT, UPDATE ON slash_requests TO credence_user;
   ```

3. **Enable audit logging:**
   ```sql
   ALTER TABLE slash_requests ENABLE ROW LEVEL SECURITY;
   ```

### Monitoring

Monitor these metrics:

- Connection pool usage
- Query performance
- Table size growth
- Index usage
- Lock contention

## Troubleshooting

### Connection Refused

```bash
# Check if PostgreSQL is running
pg_isready

# Start PostgreSQL
# macOS:
brew services start postgresql@15
# Ubuntu:
sudo systemctl start postgresql
```

### Permission Denied

```bash
# Grant permissions
psql postgres
GRANT ALL PRIVILEGES ON DATABASE credence_dev TO your_user;
\q
```

### Migration Errors

```bash
# Check current schema
psql credence_dev
\d

# Drop and recreate if needed
DROP TABLE IF EXISTS slash_requests CASCADE;
\q

# Re-run migration
psql credence_dev < src/db/migrations/001_create_slash_requests.sql
```

## Additional Resources

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [node-postgres (pg) Documentation](https://node-postgres.com/)
- [SQL Style Guide](https://www.sqlstyle.guide/)
