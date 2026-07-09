import assert from "node:assert/strict";
import test from "node:test";

import { lookupTitleMetadata } from "../src/metadata.js";

test("lookupTitleMetadata maps Google Books title results", async () => {
  const result = await lookupTitleMetadata("河南平原第四纪地质演化与环境变迁", {
    fetchImpl: async (url) => {
      assert.match(String(url), /googleapis/);
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              volumeInfo: {
                title: "河南平原第四纪地质演化与环境变迁:兼论黄河发育演化与再造",
                authors: ["李满洲"],
                publisher: "地质出版社",
                publishedDate: "2013"
              }
            }
          ]
        })
      };
    }
  });

  assert.deepEqual(result, {
    title: "河南平原第四纪地质演化与环境变迁:兼论黄河发育演化与再造",
    authors: ["李满洲"],
    journal: "地质出版社",
    year: 2013,
    abstract: "",
    authorKeywords: []
  });
});

