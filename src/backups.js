import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { initDb as initializeDb, openDb } from "./database.js";

const MANIFEST_VERSION = 1;

export class BackupValidationError extends Error {
  constructor(message = "Invalid backup manifest") {
    super(message);
    this.name = "BackupValidationError";
    this.status = 400;
  }
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("Invalid backup time");
  return date;
}

function backupTimestamp(value) {
  return asDate(value).toISOString().replace(/[:.]/g, "-");
}

function pathInside(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isManifestPathSafe(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) return false;
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return false;
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  const parts = normalized.split("/");
  return !parts.includes("..") && parts.every((part) => part && part !== ".");
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listFiles(directoryPath, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push({
        path: relativePath.replaceAll(path.sep, "/"),
        size: statSync(absolutePath).size,
        sha256: sha256File(absolutePath)
      });
    }
  }
  return files;
}

function allocateDirectory(backupsDir, timestamp, backupType) {
  const baseName = `${timestamp}-${backupType}`;
  let name = baseName;
  let counter = 1;
  while (existsSync(path.join(backupsDir, name))) name = `${baseName}-${counter++}`;
  return path.join(backupsDir, name);
}

function writeReadme(directoryPath, backupType) {
  const contents = [
    "Quaternary Paper Library backup",
    "",
    `Backup type: ${backupType}`,
    "",
    "Restore contents:",
    "- library.sqlite contains the SQLite database at backup time.",
    backupType === "full" ? "- files/ contains the library source files at backup time." : "- Database backup only; existing source files are left unchanged during restore.",
    "- manifest.json lists the relative paths, sizes, and SHA-256 hashes used for validation.",
    "",
    "This file contains no credentials or environment configuration."
  ].join("\n");
  writeFileSync(path.join(directoryPath, "README.txt"), contents, "utf8");
}

function copyDirectory(sourceDirectory, targetDirectory) {
  mkdirSync(targetDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(targetDirectory, entry.name);
    const info = lstatSync(sourcePath);
    if (info.isSymbolicLink()) {
      throw new BackupValidationError("Full backups cannot include links");
    }
    if (info.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }
    if (!info.isFile()) {
      throw new BackupValidationError("Full backups can include only regular files");
    }
    copyFileSync(sourcePath, targetPath);
  }
}

function createBackup({ dbPath, filesDir, backupsDir, backupType, reason = "manual", now = Date.now }) {
  mkdirSync(backupsDir, { recursive: true });
  const createdAt = asDate(typeof now === "function" ? now() : now).toISOString();
  const directoryPath = allocateDirectory(backupsDir, backupTimestamp(createdAt), backupType);
  mkdirSync(directoryPath, { recursive: true });

  try {
    let db;
    try {
      db = openDb(dbPath);
      try {
        db.exec("PRAGMA wal_checkpoint(FULL)");
      } catch {
        // Older SQLite builds may not support WAL checkpointing.
      }
    } finally {
      db?.close();
    }

    const databasePath = path.join(directoryPath, "library.sqlite");
    copyFileSync(dbPath, databasePath);
    if (backupType === "full") {
      copyDirectory(filesDir, path.join(directoryPath, "files"));
    }

    const manifest = {
      version: MANIFEST_VERSION,
      backupType,
      createdAt,
      reason,
      files: listFiles(directoryPath).filter((file) => file.path !== "manifest.json" && file.path !== "README.txt")
    };
    const manifestPath = path.join(directoryPath, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeReadme(directoryPath, backupType);

    return {
      backupType,
      reason,
      createdAt,
      directoryPath,
      databasePath,
      manifestPath,
      manifestSha256: sha256File(manifestPath),
      readmePath: path.join(directoryPath, "README.txt"),
      manifest,
      sizeBytes: manifest.files.reduce((total, file) => total + file.size, 0)
    };
  } catch (error) {
    rmSync(directoryPath, { recursive: true, force: true });
    throw error;
  }
}

export function createDatabaseBackup(options) {
  return createBackup({ ...options, backupType: "database" });
}

export function createFullBackup(options) {
  return createBackup({ ...options, backupType: "full" });
}

export function validateBackup(manifestPath) {
  try {
    const directoryPath = path.dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest.files) || !["database", "full"].includes(manifest.backupType)) {
      return { valid: false, error: "Invalid backup manifest" };
    }
    for (const file of manifest.files) {
      if (!isManifestPathSafe(file.path)) return { valid: false, error: "Invalid backup path" };
      if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== "string") {
        return { valid: false, error: "Invalid backup file metadata" };
      }
      const filePath = path.resolve(directoryPath, file.path);
      if (!pathInside(directoryPath, filePath) || !existsSync(filePath)) {
        return { valid: false, error: "Backup file is missing" };
      }
      if (!lstatSync(filePath).isFile()) return { valid: false, error: "Backup file is not regular" };
      if (!pathInside(realpathSync(directoryPath), realpathSync(filePath))) {
        return { valid: false, error: "Backup file is outside the backup directory" };
      }
      const actualSize = statSync(filePath).size;
      if (actualSize !== file.size) return { valid: false, error: "Backup file size differs" };
      if (sha256File(filePath) !== file.sha256) return { valid: false, error: "Backup file hash differs" };
    }
    const databaseEntry = manifest.files.find((file) => file.path === "library.sqlite");
    if (!databaseEntry) return { valid: false, error: "Backup database is missing" };
    if (manifest.backupType === "full" && !existsSync(path.join(directoryPath, "files"))) {
      return { valid: false, error: "Backup files are missing" };
    }
    return { valid: true, manifest };
  } catch {
    return { valid: false, error: "Invalid backup manifest" };
  }
}

function copyRollbackFiles(filesDir, rollbackFilesDir) {
  if (!existsSync(filesDir)) return false;
  copyDirectory(filesDir, rollbackFilesDir);
  return true;
}

export function restoreBackup({
  dbPath,
  filesDir,
  backupsDir = path.dirname(dbPath),
  backupDirectory,
  initDbImpl,
  initDb: injectedInitDb,
  now = Date.now
}) {
  const manifestPath = path.join(backupDirectory, "manifest.json");
  const validation = validateBackup(manifestPath);
  if (!validation.valid) throw new BackupValidationError(validation.error);

  const preRestore = createDatabaseBackup({ dbPath, backupsDir, reason: "pre-restore", now });
  const rollbackDirectory = path.join(backupsDir, `.rollback-${randomUUID()}`);
  const rollbackDbPath = path.join(rollbackDirectory, "library.sqlite");
  const rollbackFilesDir = path.join(rollbackDirectory, "files");
  const hadDatabase = existsSync(dbPath);
  const hadFiles = validation.manifest.backupType === "full" && existsSync(filesDir);
  const initialize = injectedInitDb ?? initDbImpl ?? initializeDb;
  mkdirSync(rollbackDirectory, { recursive: true });
  if (hadDatabase) copyFileSync(dbPath, rollbackDbPath);
  if (hadFiles) copyRollbackFiles(filesDir, rollbackFilesDir);

  try {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    copyFileSync(path.join(backupDirectory, "library.sqlite"), dbPath);
    if (validation.manifest.backupType === "full") {
      rmSync(filesDir, { recursive: true, force: true });
      copyDirectory(path.join(backupDirectory, "files"), filesDir);
    }
    initialize(dbPath, { backupsDir });
    rmSync(rollbackDirectory, { recursive: true, force: true });
    return { ...preRestore, restoredFrom: backupDirectory };
  } catch (error) {
    rmSync(dbPath, { force: true });
    if (hadDatabase) copyFileSync(rollbackDbPath, dbPath);
    if (validation.manifest.backupType === "full") {
      rmSync(filesDir, { recursive: true, force: true });
      if (hadFiles) copyDirectory(rollbackFilesDir, filesDir);
    }
    try {
      initialize(dbPath, { backupsDir });
    } catch {
      // Preserve the original restore failure after best-effort rollback initialization.
    }
    rmSync(rollbackDirectory, { recursive: true, force: true });
    throw error;
  }
}
