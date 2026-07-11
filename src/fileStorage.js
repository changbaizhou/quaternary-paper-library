import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const realpathNative = realpathSync.native || realpathSync;

function comparablePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(root, target) {
  const comparableRoot = comparablePath(root);
  const comparableTarget = comparablePath(target);
  const relative = path.relative(comparableRoot, comparableTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalizeExistingPath(target) {
  let current = target;
  const missingParts = [];

  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    missingParts.unshift(path.basename(current));
    current = parent;
  }

  let canonical;
  try {
    canonical = realpathNative(current);
  } catch {
    return null;
  }
  return missingParts.reduce((parent, part) => path.join(parent, part), canonical);
}

function resolveCandidate(filesRoot, canonicalRoot, candidate) {
  if (!isInside(filesRoot, candidate)) return null;

  const canonicalCandidate = canonicalizeExistingPath(candidate);
  if (!canonicalCandidate || !isInside(canonicalRoot, canonicalCandidate)) return null;
  if (existsSync(candidate) && !statSync(candidate).isFile()) return null;
  return existsSync(candidate) ? canonicalCandidate : candidate;
}

function safeLabel(filesRoot, resolvedPath, storedPath) {
  if (resolvedPath) {
    return path.relative(filesRoot, resolvedPath).split(path.sep).join("/");
  }
  return path.basename(String(storedPath || "").replace(/[\\/]+$/, "")) || "rejected";
}

export function resolveLibraryPdf(filesDir, storedPath) {
  if (!storedPath) return null;

  const filesRoot = path.resolve(filesDir);
  const canonicalRoot = canonicalizeExistingPath(filesRoot);
  if (!canonicalRoot || !existsSync(filesRoot) || !statSync(filesRoot).isDirectory()) return null;
  const rawPath = String(storedPath);
  const candidates = path.isAbsolute(rawPath)
    ? [path.resolve(rawPath)]
    : [path.resolve(process.cwd(), rawPath), path.resolve(filesRoot, rawPath)];

  for (const candidate of candidates) {
    if (path.extname(candidate).toLowerCase() !== ".pdf") continue;
    const resolved = resolveCandidate(filesRoot, canonicalRoot, candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export function removeLibraryFiles(
  filesDir,
  storedPaths,
  protectedStoredPaths = [],
  { removeFile = rmSync } = {}
) {
  const filesRoot = path.resolve(filesDir);
  const removed = [];
  const rejected = [];
  const missing = [];
  const failed = [];
  const seen = new Set();
  const protectedPaths = new Set();

  for (const storedPath of protectedStoredPaths || []) {
    const resolvedPath = resolveLibraryPdf(filesRoot, storedPath);
    if (resolvedPath) protectedPaths.add(comparablePath(resolvedPath));
  }

  for (const storedPath of storedPaths || []) {
    const resolvedPath = resolveLibraryPdf(filesRoot, storedPath);
    const key = resolvedPath ? comparablePath(resolvedPath) : `rejected:${String(storedPath)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = safeLabel(filesRoot, resolvedPath, storedPath);
    if (!resolvedPath) {
      rejected.push(label);
      continue;
    }
    if (protectedPaths.has(key)) continue;

    if (!existsSync(resolvedPath)) {
      missing.push(label);
      try {
        removeFile(resolvedPath, { force: true });
      } catch {
        failed.push(label);
      }
      continue;
    }

    try {
      removeFile(resolvedPath, { force: true });
      removed.push(label);
    } catch {
      failed.push(label);
    }
  }

  return { removed, rejected, missing, failed, failedCount: failed.length };
}
