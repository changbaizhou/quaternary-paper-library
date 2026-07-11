import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import properLockfile from "proper-lockfile";

import { hasPendingMigrations, runMigrations } from "./migrations.js";

export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function hasExistingSchema(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()
  );
}

function createPreMigrationSnapshot(db, backupsDir) {
  mkdirSync(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = path.join(backupsDir, `pre-migration-${timestamp}-${randomUUID()}.sqlite`);
  const escapedPath = snapshotPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);
}

const LOCK_RETRIES = 50;
const LOCK_RETRY_FACTOR = 1.2;
const LOCK_RETRY_MIN_MS = 50;
const LOCK_RETRY_MAX_MS = 250;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockDatabaseForInitialization(dbPath, onCompromised) {
  // proper-lockfile's sync adapter rejects retry options, so apply the same policy around lockSync.
  let delay = LOCK_RETRY_MIN_MS;
  for (let retry = 0; ; retry += 1) {
    try {
      return properLockfile.lockSync(dbPath, {
        realpath: false,
        stale: 10_000,
        update: 2_000,
        onCompromised
      });
    } catch (error) {
      if (error.code !== "ELOCKED" || retry >= LOCK_RETRIES) throw error;
    }

    sleep(delay);
    delay = Math.min(delay * LOCK_RETRY_FACTOR, LOCK_RETRY_MAX_MS);
  }
}

export function initDb(dbPath, { backupsDir = path.join(path.dirname(dbPath), "backups") } = {}) {
  let compromisedError;
  let initializationError;
  let releaseLock;
  let db;
  try {
    releaseLock = lockDatabaseForInitialization(dbPath, (error) => {
      compromisedError ??= error;
    });
    db = openDb(dbPath);
    if (hasExistingSchema(db) && hasPendingMigrations(db)) {
      createPreMigrationSnapshot(db, backupsDir);
    }
    runMigrations(db);
  } catch (error) {
    initializationError = error;
  } finally {
    try {
      db?.close();
    } catch (error) {
      initializationError ??= error;
    } finally {
      try {
        releaseLock?.();
      } catch (error) {
        if (!compromisedError) initializationError ??= error;
      }
    }
  }

  if (compromisedError) {
    if (initializationError && compromisedError.cause === undefined) {
      compromisedError.cause = initializationError;
    }
    throw compromisedError;
  }
  if (initializationError) throw initializationError;
}
