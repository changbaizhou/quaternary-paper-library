import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createApp } from "../src/server.js";

async function withServer(callback, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-api-"));
  const app = createApp({
    dbPath: path.join(dir, "library.sqlite"),
    filesDir: path.join(dir, "files"),
    staticDir: path.resolve("public"),
    ...overrides
  });
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("API workflow creates draft, confirms paper, searches, and exports", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "paper.pdf",
        text: `
          Holocene pollen record from a lake core on the Qinghai-Tibet Plateau
          doi: 10.1000/test.
          Abstract
          Lake sediment and pollen assemblages reveal paleoclimate changes in the East Asian monsoon margin during the Holocene.
          Keywords: Holocene; lake sediment; pollen; Qinghai-Tibet Plateau
          Introduction
        `
      })
    });
    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();
    assert.equal(draft.doi, "10.1000/test");
    assert.ok(draft.classification.periods.includes("Holocene"));

    const pendingResponse = await fetch(`${baseUrl}/api/drafts`);
    const pending = await pendingResponse.json();
    assert.equal(pending.length, 1);

    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Holocene pollen record from a lake core",
        notesCoreFindings: "Monsoon variability is reconstructed."
      })
    });
    assert.equal(confirmResponse.status, 201);
    const confirmed = await confirmResponse.json();
    assert.equal(confirmed.title, "Holocene pollen record from a lake core");

    const searchResponse = await fetch(`${baseUrl}/api/papers?query=monsoon&regions=Qinghai-Tibet%20Plateau`);
    const papers = await searchResponse.json();
    assert.equal(papers.length, 1);
    assert.equal(papers[0].id, confirmed.id);

    const exportResponse = await fetch(`${baseUrl}/api/export/bibtex`);
    const bibtex = await exportResponse.text();
    assert.match(bibtex, /@article/);
    assert.match(bibtex, /doi = \{10.1000\/test\}/);
  });
});

test("API falls back to decoded filename when extracted PDF text is sparse", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "æ²³åå¹³åç¬¬åçºªå°è´¨æ¼åä¸ç¯å¢åè¿.pdf",
        text: "\n\n\n\n\n\n\n"
      })
    });

    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();
    assert.equal(draft.title, "河南平原第四纪地质演化与环境变迁");
    assert.deepEqual(draft.classification.regions, ["Henan Plain"]);
    assert.deepEqual(draft.classification.periods, ["Quaternary"]);
    assert.match(draft.abstract, /扫描版/);
  });
});

test("API enriches sparse uploaded PDF text with OCR output", async () => {
  let ocrCalled = false;

  await withServer(
    async (baseUrl) => {
      const form = new FormData();
      form.append("files", new Blob(["fake pdf"], { type: "application/pdf" }), "scan.pdf");

      const createResponse = await fetch(`${baseUrl}/api/uploads`, {
        method: "POST",
        body: form
      });

      assert.equal(createResponse.status, 201);
      const [draft] = await createResponse.json();
      assert.equal(ocrCalled, true);
      assert.equal(draft.title, "Late Quaternary evolution of the Henan Plain");
      assert.ok(draft.classification.regions.includes("Henan Plain"));
      assert.ok(draft.extractedText.includes("optical character recognition"));
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => "\n\n\n",
      extractOcrText: async () => {
        ocrCalled = true;
        return {
          used: true,
          reason: "",
          pages: 1,
          text: `
            Late Quaternary evolution of the Henan Plain
            Abstract
            This scanned paper uses optical character recognition to identify Quaternary
            geological evolution in the Henan Plain from regional sediment records.
            Keywords: Quaternary; Henan Plain; OCR
            Introduction
          `
        };
      }
    }
  );
});

test("API prefers OCR text when PDF text extraction fails", async () => {
  await withServer(
    async (baseUrl) => {
      const form = new FormData();
      form.append("files", new Blob(["fake pdf"], { type: "application/pdf" }), "scan.pdf");

      const createResponse = await fetch(`${baseUrl}/api/uploads`, {
        method: "POST",
        body: form
      });

      assert.equal(createResponse.status, 201);
      const [draft] = await createResponse.json();
      assert.equal(draft.title, "Scanned Quaternary record from the Yellow River Basin");
      assert.notEqual(draft.title, "PDF text extraction failed: invalid pdf");
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => {
        throw new Error("invalid pdf");
      },
      extractOcrText: async () => ({
        used: true,
        reason: "",
        pages: 1,
        text: `
          Scanned Quaternary record from the Yellow River Basin
          Abstract
          Optical character recognition recovered enough text for metadata parsing.
          Keywords: Quaternary; Yellow River basin
          Introduction
        `
      })
    }
  );
});
