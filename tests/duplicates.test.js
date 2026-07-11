import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initDb, openDb } from "../src/database.js";
import { PaperRepository } from "../src/repository.js";
import { fingerprintBuffer, normalizeDoi, normalizeTitle, titleSimilarity } from "../src/duplicates.js";

test("duplicate helpers normalize identifiers and rank near-identical titles", () => {
  assert.equal(fingerprintBuffer(Buffer.from("paper")), "382635c9325bf3273d195ff1b8a44e5b11afd7d97addeb8863ea35feb98c1a07");
  assert.equal(normalizeDoi("https://doi.org/10.1000/ABC. "), "10.1000/abc");
  assert.equal(normalizeTitle("Loess–Palaeosol: Record"), "loess palaeosol record");
  assert.equal(normalizeTitle("The"), "");
  assert.ok(titleSimilarity("Holocene lake sediment record", "A Holocene lake-sediment record") >= 0.9);
  assert.ok(titleSimilarity("Holocene lake sediment record", "Marine terrace chronology") < 0.5);
});

test("duplicate groups scan 10,000 papers within a bounded time and stay deterministic", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-duplicate-perf-"));
  const dbPath = path.join(dir, "library.sqlite");

  try {
    initDb(dbPath);
    const db = openDb(dbPath);
    try {
      db.exec("BEGIN");
      const insert = db.prepare(
        "INSERT INTO papers (title, normalized_title, year, search_text) VALUES (?, ?, ?, ?)"
      );
      for (let index = 0; index < 10_000; index += 1) {
        const title = `Synthetic Quaternary record ${index}`;
        insert.run(title, normalizeTitle(title), 1900 + (index % 100), title.toLowerCase());
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    const repo = new PaperRepository(dbPath);
    const startedAt = performance.now();
    const first = repo.listDuplicateGroups();
    const elapsedMs = performance.now() - startedAt;
    const second = repo.listDuplicateGroups();

    assert.deepEqual(first, { sha256: [], doi: [], title: [] });
    assert.deepEqual(second, first);
    assert.ok(elapsedMs < 3_000, `duplicate scan took ${elapsedMs.toFixed(1)}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
