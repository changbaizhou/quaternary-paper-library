import { normalizeDoi, normalizeTitle } from "./duplicates.js";

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
  },
  {
    version: 2,
    up(db) {
      const columns = new Set(db.prepare("PRAGMA table_info(papers)").all().map((column) => column.name));
      const doiExpression = columns.has("doi") ? "doi" : "'' AS doi";
      const titleExpression = columns.has("title") ? "title" : "'' AS title";
      const update = db.prepare(
        "UPDATE papers SET normalized_doi = ?, normalized_title = ? WHERE id = ?"
      );
      for (const paper of db.prepare(`SELECT id, ${doiExpression}, ${titleExpression} FROM papers`).all()) {
        update.run(normalizeDoi(paper.doi), normalizeTitle(paper.title), paper.id);
      }
    }
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS paper_pages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          page_number INTEGER NOT NULL CHECK (page_number > 0),
          text TEXT NOT NULL DEFAULT '',
          text_source TEXT NOT NULL CHECK (text_source IN ('pdf', 'ocr', 'mixed')),
          language TEXT NOT NULL DEFAULT '',
          character_count INTEGER NOT NULL DEFAULT 0 CHECK (character_count >= 0),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (paper_id, page_number)
        );
        CREATE INDEX IF NOT EXISTS idx_paper_pages_paper_page
          ON paper_pages (paper_id, page_number);
        CREATE INDEX IF NOT EXISTS idx_paper_pages_page_number
          ON paper_pages (page_number);
      `);

      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS paper_pages_fts
          USING fts5(text, content='paper_pages', content_rowid='id');
        `);
      } catch (error) {
        throw new Error("SQLite FTS5 is required for paper page indexing", { cause: error });
      }

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS paper_pages_ai
        AFTER INSERT ON paper_pages
        BEGIN
          INSERT INTO paper_pages_fts (rowid, text) VALUES (new.id, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS paper_pages_au
        AFTER UPDATE OF text, text_source, language, character_count, updated_at ON paper_pages
        BEGIN
          INSERT INTO paper_pages_fts (paper_pages_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
          INSERT INTO paper_pages_fts (rowid, text) VALUES (new.id, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS paper_pages_ad
        AFTER DELETE ON paper_pages
        BEGIN
          INSERT INTO paper_pages_fts (paper_pages_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
        END;
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
