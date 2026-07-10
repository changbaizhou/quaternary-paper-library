import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("main paper panel contains list and PDF reader views", async () => {
  const html = await readFile("public/index.html", "utf8");

  assert.match(html, /id="paperListView"/);
  assert.match(html, /id="readerView"/);
  assert.match(html, /id="backToListButton"/);
  assert.match(html, /id="pdfViewer"/);
});

test("frontend loads PDF.js and opens selected papers in the reader", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /pdfjs-dist\/build\/pdf\.mjs/);
  assert.match(script, /openPaperReader/);
  assert.match(script, /\/api\/papers\/\$\{paper\.id\}\/file/);
  assert.match(script, /pdfjsLib\.getDocument\(\{\s*url: sourceUrl\s*\}\)/);
});

test("frontend reader supports continuous lazy scrolling", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /renderContinuousPages/);
  assert.match(script, /IntersectionObserver/);
  assert.match(script, /data-page-number/);
  assert.match(script, /scrollToPage/);
});

test("frontend reader uses fit-width high-resolution rendering", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /calculateFitWidthScale/);
  assert.match(script, /HIGH_RESOLUTION_SCALE/);
  assert.match(script, /Math\.max\(window\.devicePixelRatio \|\| 1, HIGH_RESOLUTION_SCALE\)/);
});

test("frontend reader resets state when returning to the list", async () => {
  const script = await readFile("public/app.js", "utf8");

  assert.match(script, /closeReaderAndShowList/);
  assert.match(script, /state\.selectedPaper = null/);
  assert.match(script, /setStatus\("本地资料库"\)/);
});
