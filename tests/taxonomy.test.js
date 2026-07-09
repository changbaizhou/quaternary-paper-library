import assert from "node:assert/strict";
import test from "node:test";

import { classifyText } from "../src/taxonomy.js";

test("classifies quaternary geology dimensions", () => {
  const result = classifyText({
    title: "Holocene pollen record from a lake core on the Qinghai-Tibet Plateau",
    abstract:
      "Lake sediment and pollen assemblages reveal paleoclimate changes in the East Asian monsoon margin during the Holocene.",
    keywords: ["Holocene", "lake sediment", "pollen", "Qinghai-Tibet Plateau"]
  });

  assert.ok(result.classification.themes.includes("lake sediment"));
  assert.ok(result.classification.regions.includes("Qinghai-Tibet Plateau"));
  assert.ok(result.classification.periods.includes("Holocene"));
  assert.ok(result.classification.materials.includes("lake core"));
  assert.ok(result.classification.methods.includes("pollen"));
  assert.ok(result.classification.proxies.includes("pollen"));
  assert.ok(result.confidence.periods.Holocene >= 0.6);
  assert.ok(result.evidence.periods.Holocene.includes("Holocene"));
});

