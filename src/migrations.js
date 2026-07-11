function tableExists(db, tableName) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
  );
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

const migrations = [
  {
    version: 1,
    up(db) {
      ensureColumn(db, "drafts", "file_sha256", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "drafts", "duplicate_candidates_json", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn(db, "papers", "normalized_doi", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "normalized_title", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "file_sha256", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "version", "INTEGER NOT NULL DEFAULT 1");
      ensureColumn(db, "papers", "deleted_at", "TEXT");
      ensureColumn(db, "papers", "merged_into_id", "INTEGER");
      db.exec(`
        CREATE TABLE IF NOT EXISTS paper_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          paper_id INTEGER,
          draft_id INTEGER,
          stored_filename TEXT NOT NULL DEFAULT '',
          stored_path TEXT NOT NULL DEFAULT '',
          sha256 TEXT NOT NULL DEFAULT '',
          size_bytes INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_paper_files_sha256 ON paper_files(sha256);
        CREATE INDEX IF NOT EXISTS idx_paper_files_paper ON paper_files(paper_id);
        CREATE TABLE IF NOT EXISTS backup_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          backup_type TEXT NOT NULL,
          stored_path TEXT NOT NULL,
          manifest_sha256 TEXT NOT NULL DEFAULT '',
          size_bytes INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS paper_merge_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_paper_id INTEGER NOT NULL,
          source_paper_id INTEGER NOT NULL,
          backup_record_id INTEGER,
          summary_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_papers_deleted_at ON papers(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_papers_normalized_doi ON papers(normalized_doi);
        CREATE INDEX IF NOT EXISTS idx_papers_normalized_title ON papers(normalized_title);
      `);
      db.exec(`
        INSERT INTO paper_files (paper_id, stored_filename, stored_path, sha256)
        SELECT id, stored_filename, stored_path, file_sha256
        FROM papers
        WHERE stored_path <> ''
          AND NOT EXISTS (SELECT 1 FROM paper_files WHERE paper_files.paper_id = papers.id);
        INSERT INTO paper_files (draft_id, stored_filename, stored_path, sha256)
        SELECT id, stored_filename, stored_path, file_sha256
        FROM drafts
        WHERE stored_path <> ''
          AND NOT EXISTS (SELECT 1 FROM paper_files WHERE paper_files.draft_id = drafts.id);
      `);
    }
  }
];

function appliedVersions(db) {
  if (!tableExists(db, "schema_migrations")) return new Set();
  return new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
}

export function hasPendingMigrations(db) {
  const applied = appliedVersions(db);
  return migrations.some((migration) => !applied.has(migration.version));
}

export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = appliedVersions(db);
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
