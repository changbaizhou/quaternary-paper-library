import { normalizeDoi, normalizeTitle } from "./duplicates.js";

const referenceHeading = /^\s*(references|bibliography|参考文献|引用文献)\s*[:：]?\s*$/iu;
const yearPattern = /\b((?:19|20)\d{2})[a-z]?\b/iu;
const doiPattern = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/iu;
const assetPattern = /^\s*((?:fig(?:ure)?\.?|table)\s*\d+[a-z]?|[图表]\s*\d+(?:[-.]\d+)?)\s*[.:：]?\s*(.+?)\s*$/iu;
const manualRelationTypes = new Set(["cites", "supports", "opposes", "related", "custom"]);

function cleanLine(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function plainText(value, field, { required = false, maxLength = 5000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  if (value.length > maxLength) throw new RangeError(`${field} is too long`);
  if (value.includes("\0") || /<\/?[a-z][^>]*>/iu.test(value)) throw new TypeError(`${field} must be plain text`);
  return cleanLine(value);
}

export function normalizeCustomTermInput(input = {}, { partial = false } = {}) {
  const output = {};
  if (!partial || Object.hasOwn(input, "canonical")) {
    output.canonical = plainText(input.canonical, "canonical", { required: true, maxLength: 200 });
    if (!output.canonical) throw new TypeError("canonical is required");
  }
  if (!partial || Object.hasOwn(input, "aliases")) {
    if (!Array.isArray(input.aliases) || input.aliases.some((alias) => typeof alias !== "string")) {
      throw new TypeError("aliases must be an array of strings");
    }
    output.aliases = input.aliases
      .map((alias) => plainText(alias, "alias", { maxLength: 200 }))
      .filter((alias, index, aliases) => alias && aliases.findIndex((candidate) => candidate.toLowerCase() === alias.toLowerCase()) === index)
      .slice(0, 50);
  }
  if (!partial || Object.hasOwn(input, "category")) {
    output.category = plainText(input.category ?? "custom", "category", { maxLength: 100 }) || "custom";
  }
  if (!partial || Object.hasOwn(input, "definition")) {
    output.definition = plainText(input.definition, "definition");
  }
  return output;
}

export function normalizePaperRelationInput(input = {}) {
  const targetPaperId = Number(input.targetPaperId);
  if (!Number.isSafeInteger(targetPaperId) || targetPaperId < 1) throw new TypeError("targetPaperId is invalid");
  const relationType = String(input.relationType || "related").trim().toLowerCase();
  if (!manualRelationTypes.has(relationType)) throw new TypeError("relationType is invalid");
  return {
    targetPaperId,
    relationType,
    reason: plainText(input.reason, "reason", { maxLength: 1000 })
  };
}

function stripDoi(value) {
  return cleanLine(value)
    .replace(/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*[:：]?\s*)?10\.\d{4,9}\/[-._;()/:a-z0-9]+/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function referenceTitle(rawText, year) {
  const raw = stripDoi(rawText).replace(/^\s*(?:\[?\d+\]?\s*[.)]?\s*)/, "");
  const journalTitle = raw.match(/[.。]\s*([^。.]{4,300}?)\s*\[[JDMCR]\]/iu)?.[1];
  if (journalTitle) return cleanLine(journalTitle);
  const yearMatch = raw.match(new RegExp(`(?:\\(|[.,，。]\\s*)?${year}[a-z]?\\)?[.，,、:]?\\s*`, "iu"));
  if (!yearMatch || yearMatch.index === undefined) return "";
  const tail = raw.slice(yearMatch.index + yearMatch[0].length).trim();
  return cleanLine(tail.split(/[.。]\s+(?=[\p{Lu}\p{Script=Han}])/u, 1)[0]).replace(/[.。,，;；]+$/u, "");
}

function isReferenceStart(line) {
  if (!yearPattern.test(line)) return false;
  return /^\s*(?:\[?\d+\]?\s*[.)]?\s*)?[\p{L}\p{Script=Han}]/u.test(line);
}

export function parsePaperReferences(pages = []) {
  const entries = [];
  let inReferences = false;
  let current = null;

  const flush = () => {
    if (!current) return;
    const rawText = cleanLine(current.rawText).slice(0, 4000);
    const year = Number(rawText.match(yearPattern)?.[1] || 0) || null;
    if (year || doiPattern.test(rawText)) {
      const doi = normalizeDoi(rawText.match(doiPattern)?.[0] || "");
      entries.push({
        ordinal: entries.length + 1,
        pageNumber: current.pageNumber,
        rawText,
        doi,
        title: year ? referenceTitle(rawText, year) : "",
        year
      });
    }
    current = null;
  };

  for (const page of [...pages].sort((left, right) => Number(left.pageNumber) - Number(right.pageNumber))) {
    for (const sourceLine of String(page.text || "").split(/\r?\n/u)) {
      const line = cleanLine(sourceLine);
      if (!line) continue;
      if (referenceHeading.test(line)) {
        flush();
        inReferences = true;
        continue;
      }
      if (!inReferences) continue;
      if (isReferenceStart(line)) {
        flush();
        current = { pageNumber: Number(page.pageNumber), rawText: line };
      } else if (current) {
        current.rawText += ` ${line}`;
      }
    }
  }
  flush();
  return entries;
}

export function parsePaperAssets(pages = []) {
  const assets = [];
  for (const page of [...pages].sort((left, right) => Number(left.pageNumber) - Number(right.pageNumber))) {
    for (const sourceLine of String(page.text || "").split(/\r?\n/u)) {
      const match = cleanLine(sourceLine).match(assetPattern);
      if (!match) continue;
      const label = match[1].replace(/\s+/gu, " ");
      assets.push({
        pageNumber: Number(page.pageNumber),
        assetType: /^(?:table|表)/iu.test(label) ? "table" : "figure",
        label,
        caption: cleanLine(match[2]).slice(0, 2000)
      });
    }
  }
  return assets;
}

function sharedValues(left = [], right = []) {
  const rightSet = new Set((right || []).map((value) => cleanLine(value).toLowerCase()));
  return (left || []).filter((value) => rightSet.has(cleanLine(value).toLowerCase()));
}

export function scorePaperRelations(paper, candidates = []) {
  const sourceTitle = new Set(normalizeTitle(paper?.title).split(/\s+/u).filter((token) => token.length > 2));
  return candidates
    .filter((candidate) => Number(candidate.id) !== Number(paper?.id) && candidate.deletedAt === null && candidate.mergedIntoId === null)
    .map((candidate) => {
      const regions = sharedValues(paper.regions, candidate.regions);
      const methods = sharedValues(paper.methods, candidate.methods);
      const periods = sharedValues(paper.periods, candidate.periods);
      const themes = sharedValues(paper.themes, candidate.themes);
      const titleTokens = new Set(normalizeTitle(candidate.title).split(/\s+/u).filter((token) => token.length > 2));
      const titleOverlap = [...sourceTitle].filter((token) => titleTokens.has(token)).length;
      const score = regions.length * 4 + methods.length * 3 + periods.length * 2 + themes.length * 2 + titleOverlap;
      const reasons = [
        ...regions.map((value) => `同区域：${value}`),
        ...methods.map((value) => `同方法：${value}`),
        ...periods.map((value) => `同时期：${value}`),
        ...themes.map((value) => `同主题：${value}`)
      ];
      return {
        targetPaperId: Number(candidate.id),
        relationType: regions.length ? "same-region" : methods.length ? "same-method" : "related",
        score,
        reasons
      };
    })
    .filter((relation) => relation.score > 0)
    .sort((left, right) => right.score - left.score || left.targetPaperId - right.targetPaperId)
    .slice(0, 20);
}
