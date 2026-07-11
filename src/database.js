import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { hasPendingMigrations, runMigrations } from "./migrations.js";

export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  return new DatabaseSync(dbPath);
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function hasExistingSchema(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()
  );
}

function createPreMigrationSnapshot(db, backupsDir) {
  mkdirSync(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = path.join(backupsDir, `pre-migration-${timestamp}.sqlite`);
  const escapedPath = snapshotPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);
}

export function initDb(dbPath, { backupsDir = path.join(path.dirname(dbPath), "backups") } = {}) {
  const db = openDb(dbPath);
  try {
    if (hasExistingSchema(db) && hasPendingMigrations(db)) {
      createPreMigrationSnapshot(db, backupsDir);
    }

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
    runMigrations(db);
  } finally {
    db.close();
  }
}
