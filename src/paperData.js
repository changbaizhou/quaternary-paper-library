export const metadataFields = [
  "doi", "title", "authors", "journal", "year", "abstract", "keywords",
  "themes", "regions", "periods", "materials", "methods", "proxies"
];

export const noteFields = [
  "readingStatus", "notesResearchQuestion", "notesRegion", "notesMaterialsMethods",
  "notesChronology", "notesCoreFindings", "notesLimits", "notesQuotePoints", "notesPersonal"
];

const arrayFields = new Set([
  "authors", "keywords", "themes", "regions", "periods", "materials", "methods", "proxies"
]);
const storageFields = ["storedFilename", "storedPath", "fileSha256"];
const readingStatusPriority = new Map([
  ["to-read", 1],
  ["read", 2],
  ["method-reference", 3],
  ["reading", 4],
  ["must-read", 5]
]);

function isSet(value) {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function mergeArray(target, source) {
  const result = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(target) ? target : []), ...(Array.isArray(source) ? source : [])]) {
    if (!isSet(value)) continue;
    const key = String(value).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function mergeNote(target, source) {
  if (!isSet(target)) return source || "";
  if (!isSet(source) || target === source) return target;
  return `${target}\n\n--- 合并自另一篇论文记录 ---\n\n${source}`;
}

export function mergePaperData(target = {}, source = {}) {
  const merged = { ...target };

  for (const field of [...metadataFields, ...storageFields]) {
    merged[field] = arrayFields.has(field)
      ? mergeArray(target[field], source[field])
      : (isSet(target[field]) ? target[field] : source[field]);
  }

  const targetStatus = target.readingStatus;
  const sourceStatus = source.readingStatus;
  if (!isSet(targetStatus)) {
    merged.readingStatus = sourceStatus || "to-read";
  } else if (
    isSet(sourceStatus)
    && (readingStatusPriority.get(sourceStatus) || 0) > (readingStatusPriority.get(targetStatus) || 0)
  ) {
    merged.readingStatus = sourceStatus;
  } else {
    merged.readingStatus = targetStatus;
  }

  for (const field of noteFields.filter((item) => item !== "readingStatus")) {
    merged[field] = mergeNote(target[field], source[field]);
  }

  merged.bookmarkPage = isSet(target.bookmarkPage) ? target.bookmarkPage : source.bookmarkPage ?? null;
  merged.lastReadPage = Math.max(Number(target.lastReadPage || 0), Number(source.lastReadPage || 0)) || null;
  return merged;
}

export function normalizeDoi(value) {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/[\s.,;:]+$/, "");
}

export function normalizeTitle(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
