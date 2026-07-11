import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

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

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 15_000;
const OWNER_GRACE_MS = 1_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readLockOwner(ownerPath) {
  try {
    return JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function removeLock(lockPath, expectedToken = null) {
  const ownerPath = path.join(lockPath, "owner.json");
  const owner = readLockOwner(ownerPath);
  if (expectedToken && owner?.token !== expectedToken) return false;

  try {
    rmSync(ownerPath, { force: true });
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function clearStaleLock(lockPath) {
  const owner = readLockOwner(path.join(lockPath, "owner.json"));
  if (owner && !processIsAlive(owner.pid)) {
    return removeLock(lockPath, owner.token);
  }
  if (owner) return false;

  try {
    if (Date.now() - statSync(lockPath).mtimeMs > OWNER_GRACE_MS) {
      return removeLock(lockPath);
    }
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  return false;
}

function acquireInitializationLock(dbPath) {
  const lockPath = `${path.resolve(dbPath)}.init-lock`;
  const ownerPath = path.join(lockPath, "owner.json");
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }), "utf8");
      return () => removeLock(lockPath, token);
    } catch (error) {
      if (error.code !== "EEXIST") {
        try {
          rmSync(ownerPath, { force: true });
          rmdirSync(lockPath);
        } catch {
          // Preserve the original lock acquisition error.
        }
        throw error;
      }
    }

    if (clearStaleLock(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for database initialization lock: ${lockPath}`);
    }
    sleep(LOCK_RETRY_MS);
  }
}

export function initDb(dbPath, { backupsDir = path.join(path.dirname(dbPath), "backups") } = {}) {
  const releaseLock = acquireInitializationLock(dbPath);
  let db;
  try {
    db = openDb(dbPath);
    if (hasExistingSchema(db) && hasPendingMigrations(db)) {
      createPreMigrationSnapshot(db, backupsDir);
    }
    runMigrations(db);
  } finally {
    try {
      db?.close();
    } finally {
      releaseLock();
    }
  }
}
