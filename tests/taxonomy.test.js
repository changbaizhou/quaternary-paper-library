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

test("classifies Chinese paleoflood paper without introduction noise", () => {
  const result = classifyText({
    title: "开封明永宁王府遗址地层揭示的历史时期黄河洪水事件与灾变过程",
    abstract:
      "本研究以开封明代周藩永宁王府遗址的黄河古洪水沉积地层为研究对象，采用考古定年与AMS 14C测年相结合的方法确定古洪水年代，并运用粒度、磁化率、烧失量等多指标分析方法。",
    keywords: ["开封永宁王府遗址", "历史时期", "黄河洪水", "沉积记录", "小冰期"],
    text:
      "引言中提到全球古洪水研究、孢粉、植物大化石和昆虫遗存，但这些不是本文实际方法。"
  });

  assert.ok(result.classification.themes.includes("flood event"));
  assert.ok(result.classification.regions.includes("Yellow River basin"));
  assert.ok(result.classification.periods.includes("historical period"));
  assert.ok(result.classification.periods.includes("Little Ice Age"));
  assert.ok(result.classification.materials.includes("archaeological site"));
  assert.ok(result.classification.methods.includes("radiocarbon"));
  assert.ok(result.classification.methods.includes("grain size"));
  assert.ok(result.classification.methods.includes("magnetic susceptibility"));
  assert.ok(!result.classification.regions.includes("global comparison"));
  assert.ok(!result.classification.methods.includes("pollen"));
});

test("classifies event sedimentology review from title and keywords", () => {
  const result = classifyText({
    title: "事件沉积学——发展历程、研究现状及未来趋势",
    abstract:
      "本文系统总结地震、洪水、冰川、风暴、海啸、碎屑流、浊流、缺氧及火山等9类事件沉积研究进展。",
    keywords: ["event sedimentology", "development history", "research progress", "development trends", "review"]
  });

  assert.ok(result.classification.themes.includes("event sedimentology"));
  assert.ok(!result.classification.themes.includes("glacier"));
  assert.ok(!result.classification.regions.includes("global comparison"));
});

test("classifies Quaternary geology book title from filename fallback", () => {
  const result = classifyText({
    title: "河南平原第四纪地质演化与环境变迁",
    abstract: "",
    keywords: []
  });

  assert.ok(result.classification.themes.includes("geological evolution"));
  assert.ok(result.classification.themes.includes("environmental change"));
  assert.ok(result.classification.regions.includes("Henan Plain"));
  assert.ok(result.classification.periods.includes("Quaternary"));
});
