import { readFile } from "node:fs/promises";
import pdfParse from "pdf-parse";

const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;

export function normalizeForParsing(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\uE000-\uF8FF]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/([\u4e00-\u9fff])[ \t]+([\u4e00-\u9fff])/gu, "$1$2")
    .replace(/([\u4e00-\u9fff])[ \t]+([,.:;!?，。：；！？、])/gu, "$1$2")
    .replace(/([,.:;!?，。：；！？、])[ \t]+([\u4e00-\u9fff])/gu, "$1$2");
}

export function normalizeWhitespace(value) {
  return normalizeForParsing(value).replace(/\s+/g, " ").trim();
}

function cleanLine(line) {
  return normalizeWhitespace(line)
    .replace(/^[*★\-\s]+|[*★\-\s]+$/g, "")
    .trim();
}

function firstLines(text) {
  return normalizeForParsing(text)
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
}

function compactHead(text) {
  return firstLines(text).slice(0, 100).join(" ");
}

function parseCitation(text) {
  const lines = firstLines(text);
  const windows = [...lines];
  for (let i = 0; i < lines.length - 1; i += 1) windows.push(`${lines[i]} ${lines[i + 1]}`);
  for (let i = 0; i < lines.length - 2; i += 1) {
    windows.push(`${lines[i]} ${lines[i + 1]} ${lines[i + 2]}`);
  }

  for (const candidate of windows) {
    if (!/\[(?:J|J\/OL|JOL)\]/i.test(candidate)) continue;
    const match = candidate.match(
      /^(.{2,120}?)\.\s*(.{8,240}?)\s*\[(?:J|J\/OL|JOL)\]\.\s*([^,，.。]{2,80})[,，]\s*((?:19|20)\d{2})/i
    );
    if (!match) continue;
    if (/(ISSN|CN |Vol\.|No\.|第\d+卷|\d{4}年)/i.test(match[1])) continue;
    return {
      authorsText: match[1],
      title: cleanLine(match[2]),
      journal: cleanLine(match[3]),
      year: Number(match[4])
    };
  }
  return null;
}

export function detectDoi(text) {
  const normalized = normalizeForParsing(text);
  const match = normalized.match(/\b10\.\d{4,9}\/[^\s]+/i) || normalized.match(DOI_PATTERN);
  if (!match) return "";
  return match[0]
    .replace(/(?:CSTR|摘要|关键词|中图分类号|Abstract|Keywords).*$/i, "")
    .replace(/[)\].,;:，；。]+$/g, "");
}

export function parseAbstract(text) {
  const normalized = normalizeForParsing(text).replace(/\r/g, "\n");
  const chineseMatch = normalized.match(
    /(?:\[摘要\]|摘要)\s*[:：]?\s*([\s\S]{20,5000}?)(?=(?:\[关键词\]|关键词|中图分类号|文献标识码|Abstract|Key\s*words?|Keywords|0\s*引言|引言|1\s*[.、]?\s*引言|Introduction))/i
  );
  if (chineseMatch) return normalizeWhitespace(chineseMatch[1].replace(/^[:：]\s*/, ""));

  const match = normalized.match(
    /\babstract\b\s*[:.]?\s*([\s\S]{40,5000}?)(?=\n\s*(?:key\s*words?|keywords|index terms|introduction|1\.?\s+introduction)\b)/i
  );
  if (!match) return "";
  return normalizeWhitespace(match[1]);
}

export function parseKeywords(text) {
  const normalized = normalizeForParsing(text).replace(/\r/g, "\n");
  const match = normalized.match(/(?:\[关键词\]|关键词|\bkey\s*words?\b|\bkeywords\b)/i);
  if (!match) return [];

  const rest = normalized.slice(match.index + match[0].length);
  const afterColon = rest.replace(/^\s*[:：.-]?\s*/, "");
  const line = afterColon
    .split(
      /(?:\n\s*)?(?:中图分类号|文献标识码|abstract|摘要|introduction|0\s*引言|引言|1\.?\s+introduction)/i
    )[0]
    .split(/\n/)[0];

  return line
    .split(/[;,；，、/|]+/)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

export function inferTitleFromText(text) {
  const lines = firstLines(text);
  const titleLine = lines.find((line) => /^题目[:：]/.test(line));
  if (titleLine) return cleanLine(titleLine.replace(/^题目[:：]\s*/, ""));

  const doiIndex = lines.findIndex((line) => /^doi[:：]/i.test(line) || /\b10\.\d{4,9}\//i.test(line));
  if (doiIndex >= 0) {
    const collected = [];
    for (const line of lines.slice(doiIndex + 1, doiIndex + 8)) {
      if (/^(作者|摘要|\[摘要\]|CSTR|收稿|基金|通讯作者|[0-9]+\.)/.test(line)) break;
      if (collected.length >= 2 && /^[\u4e00-\u9fff]{2,4}$/.test(line)) break;
      if (/^[\u4e00-\u9fffA-Za-z0-9，、:：\-\s—()（）]+$/.test(line) || /^[—-]+$/.test(line)) {
        collected.push(line);
      }
      if (collected.length >= 4) break;
    }
    if (collected.length) return cleanLine(collected.join(""));
  }

  const citation = parseCitation(text);
  if (citation?.title) return citation.title;

  return (
    lines.find(
      (line) =>
        line.length >= 8 &&
        !/^abstract$/i.test(line) &&
        !/(ISSN|CN |Vol\.|No\.|第\d+卷|网络首发论文|Journal of)/i.test(line)
    ) || ""
  );
}

function parseNameList(source) {
  return source
    .split(/[;,；，、]+/)
    .map((name) =>
      cleanLine(name)
        .replace(/\bet\s*al\.?/i, "")
        .replace(/^等$|等$/g, "")
        .replace(/[0-9*＊\s]+$/g, "")
    )
    .filter(Boolean);
}

function parseAuthorBlock(text) {
  const lines = firstLines(text);
  const title = inferTitleFromText(text);
  const doiIndex = lines.findIndex((line) => /^doi[:：]/i.test(line) || /\b10\.\d{4,9}\//i.test(line));
  if (doiIndex < 0 || !title) return [];

  const block = [];
  let titleBuffer = "";
  let afterTitle = false;

  for (const line of lines.slice(doiIndex + 1, doiIndex + 20)) {
    if (/^(摘要|\[摘要\]|作者|收稿|基金|通讯作者)/.test(line)) break;
    if (/^[（(]?\d+[.．]/.test(line)) break;

    if (!afterTitle) {
      titleBuffer += line;
      if (titleBuffer.includes(title)) afterTitle = true;
      continue;
    }

    block.push(line);
  }

  const compact = block
    .join("")
    .replace(/[0-9*＊\s]+/g, "")
    .replace(/[（(].*$/g, "");

  return parseNameList(compact).filter((name) => /^[\u4e00-\u9fff]{2,4}$/.test(name));
}

export function parseAuthors(text) {
  const lines = firstLines(text);
  const authorsLine = lines.find((line) => /^作者[:：]/.test(line));
  if (authorsLine) return parseNameList(authorsLine.replace(/^作者[:：]\s*/, ""));

  const blockAuthors = parseAuthorBlock(text);
  const citationAuthors = parseNameList(parseCitation(text)?.authorsText || "");
  return blockAuthors.length > citationAuthors.length ? blockAuthors : citationAuthors;
}

export function parseJournal(text) {
  const citation = parseCitation(text);
  if (citation?.journal) return citation.journal;

  const lines = firstLines(text);
  const cnkiTitle = lines.find((line) => /^《.+》网络首发论文$/.test(line));
  if (cnkiTitle) return cnkiTitle.replace(/^《|》网络首发论文$/g, "");
  return "";
}

export function parseYear(text) {
  const citation = parseCitation(text);
  if (citation?.year) return citation.year;

  const head = compactHead(text);
  const dateMatch = head.match(/(?:网络首发日期|收稿日期|出版日期)[:：]\s*((?:19|20)\d{2})/);
  if (dateMatch) return Number(dateMatch[1]);
  const yearMatch = head.match(/\b((?:19|20)\d{2})\b/);
  return yearMatch ? Number(yearMatch[1]) : null;
}

export async function extractPdfText(filePath) {
  const buffer = await readFile(filePath);
  const result = await pdfParse(buffer);
  return result.text || "";
}
