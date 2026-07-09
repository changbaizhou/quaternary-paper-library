import assert from "node:assert/strict";
import test from "node:test";

import {
  detectDoi,
  inferTitleFromText,
  parseAbstract,
  parseAuthors,
  parseJournal,
  parseKeywords,
  parseYear
} from "../src/pdfExtract.js";

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

test("detectDoi handles fullwidth Chinese DOI lines and private-use hyphens", () => {
  const text = "ＤＯＩ：１０．１１９２８／ｊ．ｉｓｓｎ．１００１７４１０．２０２６．０３．１５ＣＳＴＲ：３２０８６";

  assert.equal(detectDoi(text), "10.11928/j.issn.1001-7410.2026.03.15");
});

test("parses Chinese citation title authors journal and year", () => {
  const text = `
    第４６卷　第３期
    ２０２６年５月
    第　四　纪　研　究
    韩艾珊，陈盼盼，沈俊杰，等．开封明永宁王府遗址地层揭示的历史时期黄河洪水事件与灾变过程［Ｊ］．第四纪研究，２０２６，４６（３）：６１１－６２３．
    ＤＯＩ：１０．１１９２８／ｊ．ｉｓｓｎ．１００１７４１０．２０２６．０３．１５
    开封明永宁王府遗址地层揭示的历史时期
    黄河洪水事件与灾变过程
  `;

  assert.equal(inferTitleFromText(text), "开封明永宁王府遗址地层揭示的历史时期黄河洪水事件与灾变过程");
  assert.deepEqual(parseAuthors(text), ["韩艾珊", "陈盼盼", "沈俊杰"]);
  assert.equal(parseJournal(text), "第四纪研究");
  assert.equal(parseYear(text), 2026);
});

test("prefers full Chinese author block when citation uses et al", () => {
  const text = `
    ＤＯＩ：１０．１１９２８／ｊ．ｉｓｓｎ．１００１７４１０．２０２６．０３．１５
    开封明永宁王府遗址地层揭示的历史时期
    黄河洪水事件与灾变过程
    韩艾珊
    １，２
    ，陈盼盼
    １
    ，沈俊杰
    １
    ，王三营
    ３
    ，曹金萍
    ２
    ，
    万军卫
    ３
    ，贾明明
    １
    ，鲁鹏
    １
    （１．河南省科学院地理研究所，郑州４５００５２）
  `;

  assert.deepEqual(parseAuthors(text), [
    "韩艾珊",
    "陈盼盼",
    "沈俊杰",
    "王三营",
    "曹金萍",
    "万军卫",
    "贾明明",
    "鲁鹏"
  ]);
});

test("parses CNKI first-page title and authors", () => {
  const text = `
    《成都理工大学学报(自然科学版)》网络首发论文
    题目： 事件沉积学——发展历程、研究现状及未来趋势
    作者： 田景春，张翔，林小兵，梁庆韶，王峰，孟万斌，杨田
    收稿日期： 2026-04-21
    网络首发日期： 2026-06-24
  `;

  assert.equal(inferTitleFromText(text), "事件沉积学——发展历程、研究现状及未来趋势");
  assert.deepEqual(parseAuthors(text), ["田景春", "张翔", "林小兵", "梁庆韶", "王峰", "孟万斌", "杨田"]);
  assert.equal(parseJournal(text), "成都理工大学学报(自然科学版)");
  assert.equal(parseYear(text), 2026);
});

test("parses Chinese abstract and keywords", () => {
  const text = `
    摘要：黄河古洪水及其引发的灾害事件历来是学术界关注的重点课题。本研究以开封明代周藩永宁王府遗址的黄河古洪水沉积地层为研究对象。
    关键词：开封永宁王府遗址；历史时期；黄河洪水；沉积记录；小冰期
    中图分类号：P426.616
  `;

  assert.match(parseAbstract(text), /黄河古洪水/);
  assert.deepEqual(parseKeywords(text), [
    "开封永宁王府遗址",
    "历史时期",
    "黄河洪水",
    "沉积记录",
    "小冰期"
  ]);
});
