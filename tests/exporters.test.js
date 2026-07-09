import assert from "node:assert/strict";
import test from "node:test";

import { exportBibtex, exportCsv, exportMarkdown } from "../src/exporters.js";

const paper = {
  id: 1,
  doi: "10.1000/test",
  title: "Holocene lake sediment record",
  authors: ["Li Wei", "Zhang Min"],
  journal: "Quaternary Science Reviews",
  year: 2026,
  abstract: "A pollen and lake sediment record.",
  keywords: ["Holocene", "lake sediment", "pollen"],
  themes: ["lake sediment"],
  regions: ["Qinghai-Tibet Plateau"],
  periods: ["Holocene"],
  materials: ["lake core"],
  methods: ["pollen"],
  proxies: ["pollen"],
  readingStatus: "to-read",
  notesCoreFindings: "Monsoon variability is reconstructed."
};

test("exportBibtex contains core fields", () => {
  const bibtex = exportBibtex([paper]);

  assert.match(bibtex, /@article\{li2026holocene/);
  assert.match(bibtex, /title = \{Holocene lake sediment record\}/);
  assert.match(bibtex, /doi = \{10.1000\/test\}/);
});

test("exportCsv can be read as comma-separated values", () => {
  const content = exportCsv([paper]);

  assert.match(content, /title,authors,year,journal,doi/);
  assert.match(content, /Qinghai-Tibet Plateau/);
});

test("exportMarkdown includes note card", () => {
  const markdown = exportMarkdown([paper]);

  assert.match(markdown, /## Holocene lake sediment record/);
  assert.match(markdown, /Monsoon variability is reconstructed\./);
});

