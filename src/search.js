import { expandQuaternarySearchTerms } from "./taxonomy.js";

const lexicalToken = /[\p{L}\p{N}\p{Script=Han}]+/gu;
const maxSearchTokens = 20;

function normalizeSearchText(value) {
  return String(value || "").normalize("NFKC");
}

function isLexical(value) {
  lexicalToken.lastIndex = 0;
  return lexicalToken.test(value);
}

function scanUnquoted(value, tokens) {
  lexicalToken.lastIndex = 0;
  for (const match of value.matchAll(lexicalToken)) {
    tokens.push({ value: match[0], phrase: false });
  }
}

export function tokenizeQuery(value) {
  const source = normalizeSearchText(value);
  const tokens = [];
  let cursor = 0;
  const quotePattern = /"([^"]*)"/g;

  for (const quote of source.matchAll(quotePattern)) {
    scanUnquoted(source.slice(cursor, quote.index), tokens);
    const phrase = quote[1].replace(/\s+/g, " ").trim();
    if (isLexical(phrase)) tokens.push({ value: phrase, phrase: true });
    cursor = quote.index + quote[0].length;
  }
  scanUnquoted(source.slice(cursor), tokens);
  return tokens;
}

function tokenKey(token) {
  return `${token.phrase ? "phrase" : "word"}:${token.value.normalize("NFKC").toLowerCase()}`;
}

function quoteFtsToken(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function buildGroups(tokens, semantic, termGroups) {
  return tokens.map((token) => {
    const expanded = expandQuaternarySearchTerms(token.value, { semantic, additionalGroups: termGroups })
      .map((value) => ({ value, phrase: token.phrase }))
      .filter((candidate, index, values) => values.findIndex((item) => tokenKey(item) === tokenKey(candidate)) === index);
    return expanded;
  });
}

export function buildSearchQuery(value, { semantic = true, termGroups = [] } = {}) {
  const tokens = tokenizeQuery(value);
  if (tokens.length === 0) return null;

  const groups = [];
  let tokenCount = 0;
  for (const group of buildGroups(tokens, semantic, termGroups)) {
    if (tokenCount >= maxSearchTokens) break;
    const limited = group.slice(0, maxSearchTokens - tokenCount);
    if (limited.length === 0) continue;
    groups.push(limited);
    tokenCount += limited.length;
  }

  const flattenedTokens = groups.flat();
  const match = groups
    .map((group) => group.length === 1
      ? quoteFtsToken(group[0].value)
      : `(${group.map((token) => quoteFtsToken(token.value)).join(" OR ")})`)
    .join(" AND ");
  const highlightTerms = [...new Set(flattenedTokens.flatMap((token) =>
    token.value.split(/\s+/).filter(Boolean)
  ))];
  const originalTerms = new Set(tokens.map((token) => token.value.normalize("NFKC").toLowerCase()));
  const expandedTerms = [...new Set(flattenedTokens
    .map((token) => token.value)
    .filter((term) => !originalTerms.has(term.normalize("NFKC").toLowerCase())))];

  return {
    tokens: flattenedTokens,
    groups,
    match,
    highlightTerms,
    semantic: Boolean(semantic),
    expandedTerms,
    maxTokens: maxSearchTokens
  };
}

export function matchesSearchGroups(value, groups) {
  const normalized = normalizeSearchText(value).toLowerCase();
  return groups.every((group) => group.some((token) => normalized.includes(token.value.toLowerCase())));
}
