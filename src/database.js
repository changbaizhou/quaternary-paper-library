import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

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
const LEASE_DURATION_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 1_000;

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

function removeLockDirectory(lockPath, expectedNonce = null) {
  const ownerPath = path.join(lockPath, "owner.json");
  const owner = readLockOwner(ownerPath);
  if (expectedNonce && owner?.nonce !== expectedNonce) return false;

  try {
    rmSync(ownerPath, { force: true });
    rmSync(path.join(lockPath, "heartbeat"), { force: true });
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function leaseIsExpired(lockPath, owner) {
  if (
    !owner ||
    typeof owner.nonce !== "string" ||
    !Number.isFinite(owner.leaseDurationMs) ||
    owner.leaseDurationMs <= 0
  ) {
    return false;
  }

  try {
    const heartbeat = statSync(path.join(lockPath, "heartbeat"));
    return Date.now() - heartbeat.mtimeMs > owner.leaseDurationMs;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function reclaimExpiredLock(lockPath) {
  const owner = readLockOwner(path.join(lockPath, "owner.json"));
  if (!leaseIsExpired(lockPath, owner)) return false;

  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }

  return removeLockDirectory(stalePath, owner.nonce);
}

function startHeartbeat(lockPath, intervalMs) {
  const heartbeatPath = path.join(lockPath, "heartbeat");
  const worker = new Worker(`
    const { utimesSync } = require("node:fs");
    const { workerData } = require("node:worker_threads");
    const beat = () => {
      try {
        const now = new Date();
        utimesSync(workerData.heartbeatPath, now, now);
      } catch (error) {
        if (error.code === "ENOENT") process.exit(0);
        throw error;
      }
    };
    beat();
    setInterval(beat, workerData.intervalMs);
  `, {
    eval: true,
    execArgv: [],
    workerData: { heartbeatPath, intervalMs }
  });
  worker.unref();
  return worker;
}

function releasePublishedLock(lockPath, nonce, heartbeatWorker) {
  heartbeatWorker?.terminate();
  const owner = readLockOwner(path.join(lockPath, "owner.json"));
  if (owner?.nonce !== nonce) return false;

  const releasePath = `${lockPath}.release-${nonce}`;
  try {
    renameSync(lockPath, releasePath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return removeLockDirectory(releasePath, nonce);
}

export function acquireInitializationLock(dbPath, {
  timeoutMs = LOCK_TIMEOUT_MS,
  leaseDurationMs = LEASE_DURATION_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  beforePublish
} = {}) {
  if (heartbeatIntervalMs <= 0 || heartbeatIntervalMs >= leaseDurationMs) {
    throw new RangeError("heartbeatIntervalMs must be positive and shorter than leaseDurationMs");
  }

  const lockPath = `${path.resolve(dbPath)}.init-lock`;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    const nonce = randomUUID();
    const temporaryLockPath = `${lockPath}.tmp-${process.pid}-${nonce}`;
    try {
      mkdirSync(temporaryLockPath);
      writeFileSync(path.join(temporaryLockPath, "owner.json"), JSON.stringify({
        nonce,
        pid: process.pid,
        leaseDurationMs,
        heartbeatIntervalMs,
        publishedAt: Date.now()
      }), "utf8");
      writeFileSync(path.join(temporaryLockPath, "heartbeat"), "", "utf8");
      beforePublish?.({ lockPath, temporaryLockPath, nonce });
      renameSync(temporaryLockPath, lockPath);

      let heartbeatWorker;
      try {
        heartbeatWorker = startHeartbeat(lockPath, heartbeatIntervalMs);
      } catch (error) {
        releasePublishedLock(lockPath, nonce, null);
        throw error;
      }
      let released = false;
      return () => {
        if (released) return false;
        released = true;
        return releasePublishedLock(lockPath, nonce, heartbeatWorker);
      };
    } catch (error) {
      removeLockDirectory(temporaryLockPath, nonce);
      if (!existsSync(lockPath)) {
        throw error;
      }
    }

    if (reclaimExpiredLock(lockPath)) continue;
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
