import { readFile } from "node:fs/promises";
import pdfParse from "pdf-parse";

const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;

export function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function detectDoi(text) {
  const match = String(text || "").match(DOI_PATTERN);
  if (!match) return "";
  return match[0].replace(/[).,;:]+$/g, "");
}

export function parseAbstract(text) {
  const normalized = String(text || "").replace(/\r/g, "\n");
  const match = normalized.match(
    /\babstract\b\s*[:.]?\s*([\s\S]{40,5000}?)(?=\n\s*(?:key\s*words?|keywords|index terms|introduction|1\.?\s+introduction)\b)/i
  );
  if (!match) return "";
  return normalizeWhitespace(match[1]);
}

export function parseKeywords(text) {
  const normalized = String(text || "").replace(/\r/g, "\n");
  const match = normalized.match(
    /\bkey\s*words?\b|\bkeywords\b/i
  );
  if (!match) return [];

  const rest = normalized.slice(match.index + match[0].length);
  const afterColon = rest.replace(/^\s*[:：.-]?\s*/, "");
  const line = afterColon.split(/\n\s*(?:abstract|introduction|1\.?\s+introduction)\b/i)[0].split(/\n/)[0];

  return line
    .split(/[;,；，/|]+/)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

export function inferTitleFromText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 8 && !/^abstract$/i.test(line));
  return lines[0] || "";
}

export async function extractPdfText(filePath) {
  const buffer = await readFile(filePath);
  const result = await pdfParse(buffer);
  return result.text || "";
}

