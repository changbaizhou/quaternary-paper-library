import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initDb } from "../src/database.js";
import { PaperRepository } from "../src/repository.js";
import { parseArgs, runRebuildKnowledge } from "../scripts/rebuildKnowledge.js";

test("knowledge rebuild processes active papers deterministically without changing metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-rebuild-knowledge-"));
  const dbPath = path.join(dir, "library.sqlite");
  try {
    initDb(dbPath);
    const repo = new PaperRepository(dbPath);
    const targetId = repo.confirmDraft(repo.createDraft({ title: "Target paper", doi: "10.1000/target", classification: {} }));
    const sourceId = repo.confirmDraft(repo.createDraft({ title: "Source paper", classification: {} }));
    repo.replacePaperPages(sourceId, [{ pageNumber: 1, source: "pdf", text: "Fig. 1. Section.\nReferences\nSmith 2020. Target paper. doi:10.1000/target" }]);
    const output = [];
    const result = runRebuildKnowledge({ dbPath, output: (row) => output.push(row) });
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.results.map((row) => row.paperId), [targetId, sourceId]);
    assert.equal(output[1].references, 1);
    assert.equal(output[1].assets, 1);
    assert.equal(repo.getPaper(sourceId).title, "Source paper");
    assert.equal(repo.listPaperRelations(sourceId).stored[0].targetPaperId, targetId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("knowledge rebuild CLI accepts one paper and rejects unknown arguments", () => {
  assert.deepEqual(parseArgs(["--paper", "7"]), { paperId: 7 });
  assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
  assert.throws(() => parseArgs(["--paper", "0"]), /positive/);
});
