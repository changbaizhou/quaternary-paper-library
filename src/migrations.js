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

function ensureBaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'pending',
      original_filename TEXT NOT NULL DEFAULT '',
      stored_filename TEXT NOT NULL DEFAULT '',
      stored_path TEXT NOT NULL DEFAULT '',
      doi TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      authors_json TEXT NOT NULL DEFAULT '[]',
      journal TEXT NOT NULL DEFAULT '',
      year INTEGER,
      abstract TEXT NOT NULL DEFAULT '',
      author_keywords_json TEXT NOT NULL DEFAULT '[]',
      suggested_keywords_json TEXT NOT NULL DEFAULT '[]',
      classification_json TEXT NOT NULL DEFAULT '{}',
      confidence_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      extracted_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_draft_id INTEGER,
      stored_filename TEXT NOT NULL DEFAULT '',
      stored_path TEXT NOT NULL DEFAULT '',
      doi TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      authors_json TEXT NOT NULL DEFAULT '[]',
      journal TEXT NOT NULL DEFAULT '',
      year INTEGER,
      abstract TEXT NOT NULL DEFAULT '',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      themes_json TEXT NOT NULL DEFAULT '[]',
      regions_json TEXT NOT NULL DEFAULT '[]',
      periods_json TEXT NOT NULL DEFAULT '[]',
      materials_json TEXT NOT NULL DEFAULT '[]',
      methods_json TEXT NOT NULL DEFAULT '[]',
      proxies_json TEXT NOT NULL DEFAULT '[]',
      reading_status TEXT NOT NULL DEFAULT 'to-read',
      notes_research_question TEXT NOT NULL DEFAULT '',
      notes_region TEXT NOT NULL DEFAULT '',
      notes_materials_methods TEXT NOT NULL DEFAULT '',
      notes_chronology TEXT NOT NULL DEFAULT '',
      notes_core_findings TEXT NOT NULL DEFAULT '',
      notes_limits TEXT NOT NULL DEFAULT '',
      notes_quote_points TEXT NOT NULL DEFAULT '',
      notes_personal TEXT NOT NULL DEFAULT '',
      bookmark_page INTEGER,
      last_read_page INTEGER,
      search_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureColumn(db, "papers", "bookmark_page", "INTEGER");
  ensureColumn(db, "papers", "last_read_page", "INTEGER");
}

const migrations = [
  {
    version: 1,
    up(db) {
      ensureBaseSchema(db);
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
  for (const migration of migrations) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const alreadyApplied = db.prepare(
        "SELECT 1 FROM schema_migrations WHERE version = ?"
      ).get(migration.version);
      if (alreadyApplied) {
        db.exec("COMMIT");
        continue;
      }

      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
