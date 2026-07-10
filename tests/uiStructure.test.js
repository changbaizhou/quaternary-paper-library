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
});
