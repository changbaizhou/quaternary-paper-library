import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintBuffer, normalizeDoi, normalizeTitle, titleSimilarity } from "../src/duplicates.js";

test("duplicate helpers normalize identifiers and rank near-identical titles", () => {
  assert.equal(fingerprintBuffer(Buffer.from("paper")), "382635c9325bf3273d195ff1b8a44e5b11afd7d97addeb8863ea35feb98c1a07");
  assert.equal(normalizeDoi("https://doi.org/10.1000/ABC. "), "10.1000/abc");
  assert.equal(normalizeTitle("Loess–Palaeosol: Record"), "loess palaeosol record");
  assert.equal(normalizeTitle("The"), "");
  assert.ok(titleSimilarity("Holocene lake sediment record", "A Holocene lake-sediment record") >= 0.9);
  assert.ok(titleSimilarity("Holocene lake sediment record", "Marine terrace chronology") < 0.5);
});
