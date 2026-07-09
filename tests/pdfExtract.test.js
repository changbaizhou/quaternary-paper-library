import assert from "node:assert/strict";
import test from "node:test";

import { detectDoi, parseAbstract, parseKeywords } from "../src/pdfExtract.js";

test("detectDoi normalizes trailing punctuation", () => {
  const text = "The data are archived under doi: 10.1016/j.quascirev.2024.108123.";

  assert.equal(detectDoi(text), "10.1016/j.quascirev.2024.108123");
});

test("parseAbstract stops before keywords", () => {
  const text = `
    Title
    Abstract
    Lake sediment records from the Qinghai-Tibet Plateau document Holocene
    monsoon variability and catchment erosion.
    Keywords: Holocene; lake sediment; pollen
    Introduction
    More text.
  `;

  assert.equal(
    parseAbstract(text),
    "Lake sediment records from the Qinghai-Tibet Plateau document Holocene monsoon variability and catchment erosion."
  );
});

test("parseKeywords splits common separators", () => {
  const text = "Key words: Holocene; lake sediment, pollen / Qinghai-Tibet Plateau\nIntroduction";

  assert.deepEqual(parseKeywords(text), [
    "Holocene",
    "lake sediment",
    "pollen",
    "Qinghai-Tibet Plateau"
  ]);
});

