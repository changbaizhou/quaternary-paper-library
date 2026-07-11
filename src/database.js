import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

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

const ACQUIRE_STATE = 0;
const RELEASE_STATE = 1;
const FAILED = 2;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 20_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  update: 2_000,
  retries: { retries: 50, factor: 1.2, minTimeout: 50, maxTimeout: 250 }
};

function deserializeError(payload, fallbackMessage) {
  const error = new Error(payload?.message || fallbackMessage);
  error.name = payload?.name || "Error";
  if (payload?.code) error.code = payload.code;
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

function receivePhaseMessage(port, phase) {
  let received;
  while ((received = receiveMessageOnPort(port))) {
    if (received.message?.phase === phase) return received.message;
  }
  return null;
}

function waitForWorkerState(lock, index, timeoutMs, phase) {
  const result = Atomics.wait(lock.state, index, 0, timeoutMs);
  const status = Atomics.load(lock.state, index);
  const message = receivePhaseMessage(lock.port, phase);

  if (result === "timed-out" && status === 0) {
    throw new Error(`Timed out waiting for database initialization lock ${phase}`);
  }
  if (status === FAILED) {
    throw deserializeError(message?.error, `Database initialization lock worker failed during ${phase}`);
  }
  if (status !== 1) {
    throw new Error(`Database initialization lock worker exited unexpectedly during ${phase}`);
  }
}

function startInitializationLockWorker(dbPath, internalTestOptions = {}) {
  const stateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const state = new Int32Array(stateBuffer);
  const { port1, port2 } = new MessageChannel();
  const lockOptions = {
    ...DEFAULT_LOCK_OPTIONS,
    ...internalTestOptions.lockOptions
  };
  const worker = new Worker(new URL("./initLockWorker.js", import.meta.url), {
    execArgv: [],
    workerData: { dbPath, lockOptions, stateBuffer, controlPort: port2 },
    transferList: [port2]
  });
  worker.on("error", () => {});

  const lock = { worker, port: port1, state };
  try {
    waitForWorkerState(
      lock,
      ACQUIRE_STATE,
      internalTestOptions.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
      "acquire"
    );
    return lock;
  } catch (error) {
    port1.postMessage({ type: "release" });
    port1.close();
    void worker.terminate();
    throw error;
  }
}

function releaseInitializationLockWorker(lock, internalTestOptions = {}) {
  lock.port.postMessage({ type: "release" });
  try {
    waitForWorkerState(
      lock,
      RELEASE_STATE,
      internalTestOptions.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS,
      "release"
    );
  } finally {
    lock.port.close();
    void lock.worker.terminate();
  }
}

export function initDb(dbPath, {
  backupsDir = path.join(path.dirname(dbPath), "backups"),
  internalTestOptions = {}
} = {}) {
  let compromisedError;
  let initializationError;
  let lock;
  let db;
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    lock = startInitializationLockWorker(dbPath, internalTestOptions);
    internalTestOptions.afterLockAcquired?.();
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
        if (lock) releaseInitializationLockWorker(lock, internalTestOptions);
      } catch (error) {
        if (error.code === "ECOMPROMISED") compromisedError = error;
        else initializationError ??= error;
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
