import { existsSync, rmSync } from "node:fs";
import path from "node:path";

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  const rawPath = String(storedPath);
  const candidates = path.isAbsolute(rawPath)
    ? [path.resolve(rawPath)]
    : [path.resolve(process.cwd(), rawPath), path.resolve(filesRoot, rawPath)];

  for (const candidate of candidates) {
    if (isInside(filesRoot, candidate) && path.extname(candidate).toLowerCase() === ".pdf") {
      return candidate;
    }
  }

  return null;
}

export function removeLibraryFiles(filesDir, storedPaths) {
  const filesRoot = path.resolve(filesDir);
  const removed = [];
  const rejected = [];
  const missing = [];
  const seen = new Set();

  for (const storedPath of storedPaths || []) {
    const resolvedPath = resolveLibraryPdf(filesRoot, storedPath);
    const key = resolvedPath || `rejected:${String(storedPath)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const label = safeLabel(filesRoot, resolvedPath, storedPath);
    if (!resolvedPath) {
      rejected.push(label);
      continue;
    }

    if (!existsSync(resolvedPath)) {
      missing.push(label);
      rmSync(resolvedPath, { force: true });
      continue;
    }

    rmSync(resolvedPath, { force: true });
    removed.push(label);
  }

  return { removed, rejected, missing };
}
