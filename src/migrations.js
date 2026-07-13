import { normalizeDoi, normalizeTitle } from "./duplicates.js";

import { generateCitationKey } from "./citations.js";

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
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS annotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          paper_id INTEGER NOT NULL,
          page_number INTEGER NOT NULL CHECK (page_number > 0),
          kind TEXT NOT NULL CHECK (kind IN ('highlight', 'note', 'quote')),
          quote_text TEXT NOT NULL,
          translated_text TEXT NOT NULL DEFAULT '',
          comment TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT 'yellow',
          text_selector_json TEXT NOT NULL DEFAULT '{}',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_annotations_paper_page
          ON annotations (paper_id, page_number);

        CREATE TABLE IF NOT EXISTS research_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          annotation_id INTEGER,
          paper_id INTEGER NOT NULL,
          page_number INTEGER NOT NULL CHECK (page_number > 0),
          quote_text TEXT NOT NULL,
          translated_text TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          personal_interpretation TEXT NOT NULL DEFAULT '',
          themes_json TEXT NOT NULL DEFAULT '[]',
          evidence_type TEXT NOT NULL CHECK (evidence_type IN ('supports', 'opposes', 'method', 'background', 'uncertain')),
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_research_cards_paper_annotation
          ON research_cards (paper_id, annotation_id);
      `);
    }
  },
  {
    version: 5,
    up(db) {
      ensureColumn(db, "papers", "citation_key", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "citation_status", "TEXT NOT NULL DEFAULT 'unverified' CHECK (citation_status IN ('unverified', 'verified', 'incomplete'))");
      ensureColumn(db, "papers", "citation_checked_at", "TEXT");
      ensureColumn(db, "papers", "volume", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "issue", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "pages", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "publisher", "TEXT NOT NULL DEFAULT ''");
      ensureColumn(db, "papers", "publication_type", "TEXT NOT NULL DEFAULT 'article' CHECK (publication_type IN ('article', 'book', 'chapter', 'thesis', 'report', 'conference', 'other'))");

      const columns = new Set(db.prepare("PRAGMA table_info(papers)").all().map((column) => column.name));
      const authorsExpression = columns.has("authors_json") ? "authors_json" : "'[]' AS authors_json";
      const titleExpression = columns.has("title") ? "title" : "'' AS title";
      const yearExpression = columns.has("year") ? "year" : "NULL AS year";
      const rows = db.prepare(`
        SELECT id, citation_key, ${authorsExpression}, ${titleExpression}, ${yearExpression}
        FROM papers
        ORDER BY id ASC
      `).all();
      const existingKeys = new Set(rows.map((row) => String(row.citation_key || "")).filter(Boolean));
      const update = db.prepare("UPDATE papers SET citation_key = ? WHERE id = ?");
      for (const row of rows) {
        if (String(row.citation_key || "").trim()) continue;
        let authors = [];
        try {
          authors = JSON.parse(row.authors_json || "[]");
        } catch {
          authors = [];
        }
        const citationKey = generateCitationKey({ authors, title: row.title, year: row.year }, existingKeys);
        update.run(citationKey, row.id);
        existingKeys.add(citationKey);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_citation_key
        ON papers (citation_key)
        WHERE citation_key <> '';
      `);
    }
  },
  {
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS project_papers (
          project_id INTEGER NOT NULL,
          paper_id INTEGER NOT NULL,
          priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
          stance TEXT NOT NULL DEFAULT 'unknown' CHECK (stance IN ('supports', 'opposes', 'mixed', 'background', 'unknown')),
          project_status TEXT NOT NULL DEFAULT 'queued' CHECK (project_status IN ('queued', 'reading', 'reviewed')),
          project_note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (project_id, paper_id)
        );
        CREATE INDEX IF NOT EXISTS idx_project_papers_paper ON project_papers (paper_id);
        CREATE INDEX IF NOT EXISTS idx_project_papers_status ON project_papers (project_status);
      `);
    }
  },
  {
    version: 7,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_answers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          question TEXT NOT NULL,
          answer TEXT NOT NULL,
          citations_json TEXT NOT NULL DEFAULT '[]',
          project_id INTEGER REFERENCES research_projects(id) ON DELETE SET NULL,
          paper_ids_json TEXT NOT NULL DEFAULT '[]',
          provider TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_research_answers_project ON research_answers(project_id);
        CREATE INDEX IF NOT EXISTS idx_research_answers_created ON research_answers(created_at);
      `);
    }
  },
  {
    version: 8,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS paper_references (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal > 0),
          page_number INTEGER NOT NULL CHECK (page_number > 0),
          raw_text TEXT NOT NULL,
          doi TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          year INTEGER,
          matched_paper_id INTEGER REFERENCES papers(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (paper_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_paper_references_paper ON paper_references(paper_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_paper_references_doi ON paper_references(doi);
        CREATE INDEX IF NOT EXISTS idx_paper_references_match ON paper_references(matched_paper_id);

        CREATE TABLE IF NOT EXISTS paper_relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          target_paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL CHECK (relation_type IN ('cites', 'supports', 'opposes', 'related', 'custom')),
          reason TEXT NOT NULL DEFAULT '',
          score REAL NOT NULL DEFAULT 0,
          confirmed INTEGER NOT NULL DEFAULT 1 CHECK (confirmed IN (0, 1)),
          origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'reference')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK (source_paper_id <> target_paper_id),
          UNIQUE (source_paper_id, target_paper_id, relation_type)
        );
        CREATE INDEX IF NOT EXISTS idx_paper_relations_source ON paper_relations(source_paper_id);
        CREATE INDEX IF NOT EXISTS idx_paper_relations_target ON paper_relations(target_paper_id);

        CREATE TABLE IF NOT EXISTS paper_assets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          page_number INTEGER NOT NULL CHECK (page_number > 0),
          asset_type TEXT NOT NULL CHECK (asset_type IN ('figure', 'table')),
          label TEXT NOT NULL,
          caption TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (paper_id, page_number, asset_type, label)
        );
        CREATE INDEX IF NOT EXISTS idx_paper_assets_paper_page ON paper_assets(paper_id, page_number);

        CREATE TABLE IF NOT EXISTS custom_terms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical TEXT NOT NULL COLLATE NOCASE UNIQUE,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          category TEXT NOT NULL DEFAULT 'custom',
          definition TEXT NOT NULL DEFAULT '',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS writing_drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER UNIQUE REFERENCES research_projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '',
          citation_style TEXT NOT NULL DEFAULT 'gbt7714' CHECK (citation_style IN ('gbt7714', 'apa7')),
          cited_paper_ids_json TEXT NOT NULL DEFAULT '[]',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_writing_drafts_project ON writing_drafts(project_id);
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
