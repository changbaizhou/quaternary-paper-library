import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  return new DatabaseSync(dbPath);
}

export function initDb(dbPath) {
  const db = openDb(dbPath);
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
      search_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.close();
}

