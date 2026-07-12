import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  exportCslJson,
  exportRis,
  formatApa7,
  formatGbt7714,
  formatInTextCitation,
  generateCitationKey,
  validateCitationMetadata
} from "../src/citations.js";
import { initDb } from "../src/database.js";
import { PaperRepository } from "../src/repository.js";

const paper = {
  citationKey: "doe2024study",
  authors: ["Doe, Jane", "王小明"],
  title: "A {Study}, & More",
  year: 2024,
  journal: "Journal & Research",
  volume: "12",
  issue: "3",
  pages: "1-9",
  publisher: "Publisher {X}",
  doi: "10.1000/example",
  publicationType: "article"
};

test("generates stable unique keys for English, Chinese, missing authors, and collisions", () => {
  assert.equal(generateCitationKey({ authors: ["Smith, Jane"], year: 2024, title: "The Great Study" }, []), "smith2024the");
  assert.equal(generateCitationKey({ authors: ["Smith, Jane"], year: 2024, title: "The Great Study" }, ["smith2024the"]), "smith2024thea");
  assert.equal(generateCitationKey({ citationKey: "kept-key", authors: ["Other"], year: 2020, title: "Changed" }, ["kept-key"]), "kept-key");
  assert.match(generateCitationKey({ authors: ["张三"], year: 2020, title: "青藏高原湖泊沉积研究" }, []), /^张三2020/);
  assert.equal(generateCitationKey({ authors: [], title: "Untitled Study" }, []), "papernduntitled");
});

test("reports citation fields by publication type and verified status", () => {
  assert.deepEqual(validateCitationMetadata({ publicationType: "article", title: "A", authors: ["A"], year: 2020 }), {
    status: "incomplete",
    missingFields: ["journal"]
  });
  assert.deepEqual(validateCitationMetadata({ publicationType: "book", title: "A", authors: ["A"], year: 2020, publisher: "P" }), {
    status: "verified",
    missingFields: []
  });
  assert.deepEqual(validateCitationMetadata({ publicationType: "thesis", title: "A", authors: ["A"], year: 2020 }), {
    status: "incomplete",
    missingFields: ["publisher"]
  });
  assert.equal(validateCitationMetadata({ publicationType: "article", title: "A", authors: ["A"], year: 2020, journal: "J", citationStatus: "unverified" }).status, "unverified");
});

test("formats structured metadata without inventing fields and keeps special text plain", () => {
  const gbt = formatGbt7714(paper);
  const apa = formatApa7(paper);
  const ris = exportRis([paper]);
  const csl = JSON.parse(exportCslJson([paper]));

  assert.match(gbt, /Journal & Research, 2024, 12\(3\): 1-9/);
  assert.match(apa, /Doe, Jane/);
  assert.match(apa, /A \{Study\}, & More/);
  assert.match(ris, /TY  - JOUR/);
  assert.match(ris, /DO  - 10\.1000\/example/);
  assert.equal(csl[0].author[0].family, "Doe");
  assert.equal(csl[0].author[0].given, "Jane");
  assert.equal(csl[0].author[1].family, "王");
  assert.equal(csl[0].author[1].given, "小明");
  assert.equal(csl[0].volume, "12");
  assert.equal(csl[0].issue, "3");
  assert.equal(csl[0].page, "1-9");
  assert.doesNotMatch(apa, /undefined|null/);
});

test("uses an unambiguous title once when GB/T has no author", () => {
  const output = formatGbt7714({ title: "Authorless Study", year: 2024, publicationType: "report" });
  assert.equal((output.match(/Authorless Study/g) || []).length, 1);
});

test("formats APA and GB/T in-text citations for author counts", () => {
  assert.equal(formatInTextCitation({ ...paper, authors: ["Doe, Jane"], year: 2024 }, "apa"), "(Doe, 2024)");
  assert.equal(formatInTextCitation({ ...paper, authors: ["Doe, Jane", "Smith, John"], year: 2024 }, "apa"), "(Doe & Smith, 2024)");
  assert.equal(formatInTextCitation({ ...paper, authors: ["Doe, Jane", "Smith, John", "Lee, Kim"], year: 2024 }, "apa"), "(Doe et al., 2024)");
  assert.equal(formatInTextCitation({ ...paper, authors: ["王小明"], year: 2024 }, "gbt"), "王小明（2024）");
  assert.equal(formatInTextCitation({ ...paper, authors: [], year: 2024 }, "apa"), "(A {Study}, & More, 2024)");
});

test("migration and confirmation create unique citation keys and expose citation fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-citations-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const create = () => repo.confirmDraft(repo.createDraft({
      title: "Same Study",
      authors: ["Smith, Jane"],
      year: 2024,
      journal: "J",
      classification: {},
      confidence: {},
      evidence: {}
    }));
    const first = repo.getPaper(create());
    const second = repo.getPaper(create());
    assert.equal(first.citationKey, "smith2024same");
    assert.equal(second.citationKey, "smith2024samea");
    assert.equal(first.citationStatus, "unverified");
    assert.equal(first.publicationType, "article");
    assert.equal(first.volume, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
