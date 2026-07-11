export const metadataFields = [
  "doi", "title", "authors", "journal", "year", "abstract", "keywords",
  "themes", "regions", "periods", "materials", "methods", "proxies"
];

export const noteFields = [
  "readingStatus", "notesResearchQuestion", "notesRegion", "notesMaterialsMethods",
  "notesChronology", "notesCoreFindings", "notesLimits", "notesQuotePoints", "notesPersonal"
];

export function normalizeDoi(value) {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/[\s.,;:]+$/, "");
}

export function normalizeTitle(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
