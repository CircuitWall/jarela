---
description: "Use when: designing, querying, or migrating SQLite schemas in lib/db/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# SQLite & Database Persistence Agent

**Specialization:** Building and maintaining SQLite database schemas, migrations, queries, and checkpoint storage for Jarela's persistent state layer.

**Scope:** `lib/db/` directory — database initialization, schema migrations, query execution, transactional safety, encryption integration, and checkpoint persistence.

---

## 🎯 Domain Context

### What the Database Is

SQLite is Jarela's single source of truth for persistent state:
- **Threads:** Conversation history and metadata
- **Messages:** LangChain message format stored and indexed
- **Configurations:** Agent, model, and integration settings
- **Checkpoints:** LangGraph execution state for resumable runs
- **Credentials:** Encrypted secrets and access tokens
- **Background Operations:** Async task tracking and results

### Jarela's Database Architecture

```
Application Layer (lib/agents/, lib/stores/, etc.)
  ↓ (SQL queries)
Query Layer (prepared statements, statement cache)
  ↓ (DatabaseSync from node:sqlite)
SQLite3 Engine
  ↓ (WAL mode)
Disk File ($JARELA_DB_DIR/jarela.db + WAL/SHM)
```

### Key Principles

1. **WAL Mode is Mandatory**
   - Write-Ahead Logging enables concurrent reads + writes
   - Synchronous = OFF (app crashes won't corrupt DB, SQLite is crash-safe)
   - Foreign keys enforced (maintain referential integrity)

2. **Migrations are Immutable**
   - New schemas added to runMigrations()
   - Old migrations never deleted or changed
   - Idempotent (`IF NOT EXISTS` patterns)
   - Each app version can run old migrations

3. **Prepared Statements Only**
   - No string interpolation or concatenation
   - Always use `db.prepare(sql).run(params)`
   - Prevents SQL injection, improves performance via caching

4. **Transactions are SAVEPOINT-Based**
   - Use `withDbTransaction()` for safe ACID boundaries
   - Nested transactions via savepoints
   - Rollback on error, no manual commit

5. **Encryption is Transparent**
   - Column-level encryption for secrets
   - Keys managed in `lib/crypto/`
   - Queries use `encrypt(value)` / `decryptIfNeeded(value)`
   - No plaintext secrets on disk

6. **Queries are Indexed**
   - Common filter columns have indexes
   - Query performance budgeted during schema design
   - N+1 query patterns actively prevented

---

## 📋 Coding Patterns

### Pattern 1: Schema Definition & Migration

Add new tables in `runMigrations()`:

```typescript
// lib/db/migrations.ts
export function runMigrations(db: DatabaseSync): void {
  clearStatementCache(db);

  // 1. Define the schema (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_id     TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      title         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    );

    -- Define indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_threads_agent_id 
      ON threads(agent_id, updated_at DESC);
    
    CREATE INDEX IF NOT EXISTS idx_threads_updated 
      ON threads(updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      msg_id     TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL REFERENCES threads(thread_id),
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Index for the dominant filter (thread_id + time)
    CREATE INDEX IF NOT EXISTS idx_messages_thread_time 
      ON messages(thread_id, created_at DESC);
  `);

  // 2. Alter table for schema evolution
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === "status")) {
    db.exec("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'active'");
  }

  // 3. Data migrations (if needed)
  if (needsDataMigration()) {
    db.exec(`
      UPDATE messages 
      SET status = 'completed' 
      WHERE status IS NULL
    `);
  }
}
```

**When to use:** New tables, new columns, adding indexes, altering schemas

---

### Pattern 2: Prepared Statements with Binding

Always use parameters to prevent SQL injection:

```typescript
// lib/stores/threads.ts
import { getDb } from "@/lib/db";

export function getThread(threadId: string) {
  const db = getDb();
  
  // ✅ RIGHT: Use prepared statements with parameters
  const thread = db.prepare(`
    SELECT thread_id, agent_id, title, created_at, updated_at
    FROM threads
    WHERE thread_id = ?
  `).get(threadId) as ThreadRow | undefined;

  return thread;
}

// ❌ WRONG: Never interpolate variables
const badQuery = `SELECT * FROM threads WHERE thread_id = '${threadId}'`;

// ❌ WRONG: Never rely on string conversion
const alsoWrong = db.prepare(
  `SELECT * FROM threads WHERE thread_id = '${threadId}'`
);
```

**When to use:** Every query — reading, writing, filtering

---

### Pattern 3: Transactional Safety with Savepoints

Use `withDbTransaction()` for multi-statement changes:

```typescript
// lib/stores/threads.ts
import { withDbTransaction } from "@/lib/db/transaction";
import { getDb } from "@/lib/db";

export function createThreadWithInitialMessage(
  threadId: string,
  agentId: string,
  userMessage: string,
): void {
  withDbTransaction(() => {
    const db = getDb();

    // 1. Create thread
    db.prepare(`
      INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(threadId, agentId, "New Conversation", now(), now());

    // 2. Add first message
    db.prepare(`
      INSERT INTO messages (msg_id, thread_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), threadId, "user", userMessage, now());

    // 3. Update thread message count
    db.prepare(`
      UPDATE threads
      SET message_count = message_count + 1
      WHERE thread_id = ?
    `).run(threadId);

    // If any statement fails, all roll back. If all succeed, all commit.
  });
}
```

**When to use:** Multi-statement operations, maintaining consistency

---

### Pattern 4: Encrypted Secret Storage

Use envelope encryption for sensitive data:

```typescript
// lib/stores/integrations.ts
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";
import { getDb } from "@/lib/db";

export function saveIntegrationCredential(
  integrationId: string,
  apiKey: string,
  apiSecret: string,
): void {
  const db = getDb();

  // Encrypt before storing
  const encryptedKey = encrypt(apiKey);
  const encryptedSecret = encrypt(apiSecret);

  db.prepare(`
    INSERT OR REPLACE INTO integrations (id, provider, api_key, api_secret)
    VALUES (?, ?, ?, ?)
  `).run(integrationId, "github", encryptedKey, encryptedSecret);
}

export function getIntegrationCredential(
  integrationId: string,
): { apiKey: string; apiSecret: string } {
  const db = getDb();

  const row = db.prepare(`
    SELECT api_key, api_secret
    FROM integrations
    WHERE id = ?
  `).get(integrationId) as any;

  if (!row) throw new Error(`Integration ${integrationId} not found`);

  // Decrypt when reading
  return {
    apiKey: decryptIfNeeded(row.api_key),
    apiSecret: decryptIfNeeded(row.api_secret),
  };
}
```

**When to use:** Storing API keys, tokens, and sensitive credentials

---

### Pattern 5: Checkpoint Persistence (LangGraph)

Store and restore agent execution state:

```typescript
// lib/agents/sqlite-checkpoint-saver.ts
import { getDb } from "@/lib/db";
import type { Checkpoint } from "@langchain/langgraph";

export class SqliteCheckpointSaver {
  async put(values: any, metadata: any): Promise<void> {
    const db = getDb();
    const checkpointId = generateCheckpointId();

    withDbTransaction(() => {
      db.prepare(`
        INSERT INTO checkpoints (
          checkpoint_id, thread_id, data, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        checkpointId,
        metadata.thread_id,
        JSON.stringify(values),
        JSON.stringify(metadata),
        now(),
      );
    });
  }

  async get(threadId: string, checkpointId?: string): Promise<Checkpoint | undefined> {
    const db = getDb();

    // If no checkpointId, get the latest
    const query = checkpointId
      ? `
        SELECT data, metadata
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_id = ?
        LIMIT 1
      `
      : `
        SELECT data, metadata
        FROM checkpoints
        WHERE thread_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `;

    const params = checkpointId
      ? [threadId, checkpointId]
      : [threadId];

    const row = db.prepare(query).get(...params) as any;

    if (!row) return undefined;

    return {
      values: JSON.parse(row.data),
      metadata: JSON.parse(row.metadata),
    };
  }
}
```

**When to use:** Persisting LangGraph agent state for resumable runs

---

## ⚠️ Anti-Patterns (What NOT to Do)

### Anti-Pattern 1: String Interpolation in SQL

❌ **Wrong:**
```typescript
// SQL injection vulnerability!
const userId = getUserInput(); // "1 OR 1=1"
const user = db.prepare(`
  SELECT * FROM users WHERE id = '${userId}'
`).get();

// Or even with template literals:
const query = `SELECT * FROM users WHERE name = '${name}'`;
```

✅ **Right:**
```typescript
// Always use parameter binding
const user = db.prepare(`
  SELECT * FROM users WHERE id = ?
`).get(userId);

const users = db.prepare(`
  SELECT * FROM users WHERE name = ?
`).all(name);
```

**Why:** Parameters are escaped by SQLite, preventing injection.

---

### Anti-Pattern 2: Losing Transactions

❌ **Wrong:**
```typescript
// No transaction - crashes here lose consistency
db.prepare("INSERT INTO threads ...").run(threadData);
maybeFailHere(); // <-- If this fails, thread exists but message doesn't
db.prepare("INSERT INTO messages ...").run(messageData);
```

✅ **Right:**
```typescript
// Wrapped in transaction
withDbTransaction(() => {
  db.prepare("INSERT INTO threads ...").run(threadData);
  maybeFailHere(); // <-- If this fails, both statements roll back
  db.prepare("INSERT INTO messages ...").run(messageData);
});
```

**Why:** Transactions guarantee consistency across multiple statements.

---

### Anti-Pattern 3: Storing Secrets Unencrypted

❌ **Wrong:**
```typescript
// NEVER store plain secrets
db.prepare(`
  INSERT INTO integrations (id, api_key)
  VALUES (?, ?)
`).run(integrationId, plainApiKey); // Exposed!
```

✅ **Right:**
```typescript
// Always encrypt
const encrypted = encrypt(plainApiKey);
db.prepare(`
  INSERT INTO integrations (id, api_key)
  VALUES (?, ?)
`).run(integrationId, encrypted);

// And decrypt when reading
const row = db.prepare("SELECT api_key FROM integrations WHERE id = ?").get(id);
const decrypted = decryptIfNeeded(row.api_key);
```

**Why:** Plaintext secrets can be stolen from backups or database dumps.

---

### Anti-Pattern 4: No Indexes for Common Queries

❌ **Wrong:**
```typescript
// This query will full-scan the messages table
// (threads can have thousands of messages)
db.prepare("SELECT * FROM messages WHERE thread_id = ?").all(threadId);
```

✅ **Right:**
```typescript
// Add index during schema creation
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_thread
  ON messages(thread_id, created_at DESC);
`);

// Now the query is fast
db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC").all(threadId);
```

**Why:** Without indexes, big tables cause slow queries and CPU waste.

---

### Anti-Pattern 5: Ignoring Foreign Key Constraints

❌ **Wrong:**
```typescript
// No foreign key constraints - orphaned rows possible
CREATE TABLE messages (
  msg_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,  // Could point to non-existent thread!
  content TEXT
);

// Delete thread - messages are now orphaned
DELETE FROM threads WHERE thread_id = 'x';
```

✅ **Right:**
```typescript
// Enable foreign keys at startup
db.exec("PRAGMA foreign_keys = ON");

// Add constraints to schema
CREATE TABLE messages (
  msg_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
  content TEXT
);

// Delete thread - messages deleted automatically
DELETE FROM threads WHERE thread_id = 'x'; // Cascades to messages
```

**Why:** Foreign keys prevent orphaned data and maintain referential integrity.

---

## 📁 File Structure

### Database Core
- `index.ts` — Database initialization, schema setup, connection pooling
- `data-dir.ts` — Platform-specific database directory (`~/.jarela`, `%APPDATA%\Jarela`)
- `migrations.ts` — Schema creation, table definitions, migrations
- `statement-cache.ts` — Prepared statement cache for performance

### Transactions & Safety
- `transaction.ts` — Savepoint-based transaction wrapper
- `test-isolation.test.ts` — Test isolation with per-test databases

### Integration
- (Encryption: `lib/crypto/envelope.ts`)
- (Queries: throughout `lib/stores/`)
- (Checkpoints: `lib/agents/sqlite-checkpoint-saver.ts`)

---

## 🧪 Testing Requirements

### Unit Tests: Query Functions

Every query function needs tests:

```typescript
// lib/stores/threads.test.ts
import { createThread, getThread, updateThread } from "@/lib/stores/threads";
import { getDb } from "@/lib/db";

describe("threads", () => {
  beforeEach(() => {
    // Fresh DB for each test
    const db = getDb();
    db.exec("DELETE FROM messages");
    db.exec("DELETE FROM threads");
  });

  it("creates a thread", () => {
    const threadId = "test-thread-1";
    createThread(threadId, "agent-1", "Test Title");

    const thread = getThread(threadId);
    expect(thread).toBeDefined();
    expect(thread?.title).toBe("Test Title");
  });

  it("returns undefined for non-existent thread", () => {
    const thread = getThread("non-existent");
    expect(thread).toBeUndefined();
  });

  it("updates thread title", () => {
    createThread("t1", "a1", "Old Title");
    updateThread("t1", { title: "New Title" });

    const thread = getThread("t1");
    expect(thread?.title).toBe("New Title");
  });
});
```

### Unit Tests: Migrations

```typescript
// lib/db/migrations.test.ts
import { runMigrations } from "@/lib/db/migrations";
import { DatabaseSync } from "node:sqlite";

describe("migrations", () => {
  it("creates required tables", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);

    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
    `).all() as Array<{ name: string }>;

    expect(tables.map(t => t.name)).toContain("threads");
    expect(tables.map(t => t.name)).toContain("messages");
  });

  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    
    runMigrations(db);
    const first = db.prepare("SELECT COUNT(*) as count FROM threads").get() as any;

    // Running again should succeed without error
    runMigrations(db);
    const second = db.prepare("SELECT COUNT(*) as count FROM threads").get() as any;

    expect(second.count).toBe(first.count);
  });

  it("creates indexes", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index'
    `).all() as Array<{ name: string }>;

    expect(indexes.map(i => i.name)).toContain("idx_messages_thread_time");
  });
});
```

### Integration Tests: Transactions

```typescript
// lib/db/transaction.test.ts
import { withDbTransaction } from "@/lib/db/transaction";
import { createThread, getThread } from "@/lib/stores/threads";

describe("transactions", () => {
  it("rolls back on error", () => {
    const threadId = "t1";

    try {
      withDbTransaction(() => {
        createThread(threadId, "a1", "Title");
        throw new Error("Intentional failure");
      });
    } catch {
      // Expected
    }

    // Thread should not exist
    const thread = getThread(threadId);
    expect(thread).toBeUndefined();
  });

  it("commits on success", () => {
    const threadId = "t1";

    withDbTransaction(() => {
      createThread(threadId, "a1", "Title");
      // No error, so commits
    });

    const thread = getThread(threadId);
    expect(thread).toBeDefined();
    expect(thread?.title).toBe("Title");
  });
});
```

---

## 🎓 Common Mistakes & Fixes

### Mistake 1: Forgetting PRAGMA foreign_keys = ON

**Problem:**
```typescript
// Foreign key constraints are DISABLED by default in SQLite!
DELETE FROM threads WHERE thread_id = 'x'; // Messages stay orphaned
```

**Fix:**
```typescript
// Enable in getDb() during initialization
export function getDb(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON"); // Enforce constraints
  // ... rest of initialization
  return db;
}
```

---

### Mistake 2: N+1 Queries

**Problem:**
```typescript
// ❌ SLOW: Load all threads, then load messages one-by-one
const threads = db.prepare("SELECT * FROM threads").all();
for (const thread of threads) {
  const messages = db.prepare("SELECT * FROM messages WHERE thread_id = ?")
    .all(thread.thread_id);
  // ... process
}
// If 1000 threads with 10 messages each = 1001 queries!
```

**Fix:**
```typescript
// ✅ FAST: Join in one query
const results = db.prepare(`
  SELECT t.thread_id, t.title, m.msg_id, m.content
  FROM threads t
  LEFT JOIN messages m ON t.thread_id = m.thread_id
  ORDER BY t.thread_id, m.created_at
`).all();

// Process results grouped by thread
```

---

### Mistake 3: Missing Index on Foreign Key

**Problem:**
```typescript
// Queries like this will full-scan if there's no index
db.prepare("SELECT * FROM messages WHERE thread_id = ?").all(threadId);
// With 100K messages and 1K threads, this is SLOW without an index
```

**Fix:**
```typescript
// Add index to foreign key column
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_thread_id
  ON messages(thread_id);
`);

// Or for range queries:
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_thread_time
  ON messages(thread_id, created_at DESC);
`);
```

---

### Mistake 4: Not Encrypting Secrets

**Problem:**
```typescript
// Secret stored in plaintext
db.prepare(
  "INSERT INTO integrations (api_key) VALUES (?)"
).run(plainApiKey); // Oops - now it's in the database unencrypted
```

**Fix:**
```typescript
// Always encrypt before storing
import { encrypt } from "@/lib/crypto/envelope";

const encrypted = encrypt(plainApiKey);
db.prepare(
  "INSERT INTO integrations (api_key) VALUES (?)"
).run(encrypted);

// Decrypt when reading
import { decryptIfNeeded } from "@/lib/crypto/envelope";
const row = db.prepare("SELECT api_key FROM integrations").get() as any;
const plainKey = decryptIfNeeded(row.api_key);
```

---

### Mistake 5: Huge Transactions

**Problem:**
```typescript
// Transaction holds locks for too long
withDbTransaction(() => {
  for (const item of largeList) {
    // Insert 100K items - locks DB for minutes
    db.prepare("INSERT INTO data (value) VALUES (?)").run(item);
  }
});
```

**Fix:**
```typescript
// Batch into smaller transactions
const batchSize = 1000;
for (let i = 0; i < largeList.length; i += batchSize) {
  withDbTransaction(() => {
    for (let j = i; j < i + batchSize && j < largeList.length; j++) {
      db.prepare("INSERT INTO data (value) VALUES (?)").run(largeList[j]);
    }
  });
}
```

---

## ✅ Pre-PR Alignment Checklist

Before submitting a PR with database changes, verify:

- [ ] **Migrations are correct**
  - [ ] New tables use `CREATE TABLE IF NOT EXISTS`
  - [ ] New columns use `ALTER TABLE IF NOT EXISTS`
  - [ ] Migrations are idempotent (can run multiple times)
  - [ ] Migrations preserve existing data

- [ ] **Queries use parameters**
  - [ ] No string interpolation in SQL
  - [ ] All user input bound as parameters
  - [ ] No SQL injection vulnerabilities

- [ ] **Transactions are used**
  - [ ] Multi-statement operations wrapped in `withDbTransaction()`
  - [ ] Rollback on error is tested
  - [ ] Atomic operations stay consistent

- [ ] **Secrets are encrypted**
  - [ ] API keys, tokens stored with `encrypt()`
  - [ ] Secrets decrypted with `decryptIfNeeded()` when read
  - [ ] No plaintext secrets on disk

- [ ] **Performance is acceptable**
  - [ ] Common queries have indexes
  - [ ] No N+1 query patterns
  - [ ] Joins used instead of multiple queries
  - [ ] Query times < 100ms for typical operations

- [ ] **Foreign keys are enforced**
  - [ ] Foreign key constraints defined
  - [ ] `PRAGMA foreign_keys = ON` set
  - [ ] `ON DELETE CASCADE` or `ON DELETE RESTRICT` specified

- [ ] **Tests cover new code**
  - [ ] Query functions tested (happy path + edge cases)
  - [ ] Migration idempotency tested
  - [ ] Transaction rollback tested
  - [ ] >90% coverage on changed files

- [ ] **No unencrypted secrets in test data**
  - [ ] Test fixtures don't contain real API keys
  - [ ] Mocked credentials clearly labeled
  - [ ] No sensitive data in test output

---

## ❓ FAQ

**Q: Where does Jarela store its database?**

A: Platform-specific: `~/.jarela/` on Linux/macOS, `%LOCALAPPDATA%\Jarela\` on Windows. Configurable via `JARELA_DB_DIR` environment variable.

---

**Q: How do I add a new table?**

A: Add the `CREATE TABLE IF NOT EXISTS` statement to `runMigrations()` in `lib/db/migrations.ts`. It's idempotent, so existing databases won't error. Create indexes for common query columns at the same time.

---

**Q: Can I query the database directly?**

A: Yes, via the SQLite CLI: `sqlite3 ~/.jarela/jarela.db`. But use the typed stores (`lib/stores/*.ts`) for normal operations—they handle encryption and validation.

---

**Q: Why savepoints instead of transactions?**

A: Savepoints allow nested transactions. If one function calls another that also needs transactional safety, savepoints handle it. Transactions would fail. Both are ACID.

---

**Q: How do I backup the database?**

A: Copy `$JARELA_DB_DIR/jarela.db*` (includes `.db-wal` and `.db-shm`). All three files are needed for a consistent backup. Jarela will re-create `.db-wal` and `.db-shm` on next startup.

---

**Q: What happens if the database gets corrupted?**

A: SQLite has built-in recovery via the WAL. If `jarela.db` is corrupted, try: `sqlite3 ~/.jarela/jarela.db "PRAGMA integrity_check;"` to see issues. SQLite can usually recover automatically on next open. Worst case, restore from backup.

