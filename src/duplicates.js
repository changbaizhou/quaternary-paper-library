import { createHash } from "node:crypto";

import {
  normalizeDoi as normalizePaperDoi,
  normalizeTitle as normalizePaperTitle
} from "./paperData.js";

export const normalizeDoi = normalizePaperDoi;

export function normalizeTitle(value) {
  return normalizePaperTitle(value).replace(/^(?:a|an|the)(?:\s+|$)/u, "").trim();
}

export function fingerprintBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function titleBigrams(value) {
  const words = normalizeTitle(value).split(/\s+/u).filter(Boolean);
  const bigrams = new Set();
  for (let index = 0; index < words.length - 1; index += 1) {
    bigrams.add(`${words[index]} ${words[index + 1]}`);
  }
  return bigrams;
}

export function titleSimilarity(left, right) {
  const normalizedLeft = normalizeTitle(left);
  const normalizedRight = normalizeTitle(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;

  const leftBigrams = titleBigrams(normalizedLeft);
  const rightBigrams = titleBigrams(normalizedRight);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0;

  let intersection = 0;
  for (const bigram of leftBigrams) {
    if (rightBigrams.has(bigram)) intersection += 1;
  }
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}
