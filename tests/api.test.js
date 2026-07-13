import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createApp } from "../src/server.js";
import { openDb } from "../src/database.js";
import { fingerprintBuffer } from "../src/duplicates.js";
import { PaperRepository } from "../src/repository.js";

async function withServer(callback, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qpl-api-"));
  const app = createApp({
    dbPath: path.join(dir, "library.sqlite"),
    filesDir: path.join(dir, "files"),
    backupsDir: path.join(dir, "backups"),
    automaticBackupsEnabled: false,
    staticDir: path.resolve("public"),
    ...overrides
  });
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await callback(baseUrl, {
      dbPath: path.join(dir, "library.sqlite"),
      dir,
      filesDir: path.join(dir, "files"),
      backupsDir: path.join(dir, "backups")
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("API workflow creates draft, confirms paper, searches, and exports", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "paper.pdf",
        text: `
          Holocene pollen record from a lake core on the Qinghai-Tibet Plateau
          doi: 10.1000/test.
          Abstract
          Lake sediment and pollen assemblages reveal paleoclimate changes in the East Asian monsoon margin during the Holocene.
          Keywords: Holocene; lake sediment; pollen; Qinghai-Tibet Plateau
          Introduction
        `
      })
    });
    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();
    assert.equal(draft.doi, "10.1000/test");
    assert.ok(draft.classification.periods.includes("Holocene"));

    const pendingResponse = await fetch(`${baseUrl}/api/drafts`);
    const pending = await pendingResponse.json();
    assert.equal(pending.length, 1);

    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Holocene pollen record from a lake core",
        notesCoreFindings: "Monsoon variability is reconstructed."
      })
    });
    assert.equal(confirmResponse.status, 201);
    const confirmed = await confirmResponse.json();
    assert.equal(confirmed.title, "Holocene pollen record from a lake core");

    const repeatedConfirm = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Duplicate confirmation" })
    });
    assert.equal(repeatedConfirm.status, 409);

    const searchResponse = await fetch(`${baseUrl}/api/papers?query=monsoon&regions=Qinghai-Tibet%20Plateau`);
    const papers = await searchResponse.json();
    assert.equal(papers.length, 1);
    assert.equal(papers[0].id, confirmed.id);

    const exportResponse = await fetch(`${baseUrl}/api/export/bibtex`);
    const bibtex = await exportResponse.text();
    assert.match(bibtex, /@article/);
    assert.match(bibtex, /doi = \{10.1000\/test\}/);
  });
});

test("backup API creates, lists, and restores a database backup", async () => {
  await withServer(async (baseUrl, { dbPath, backupsDir }) => {
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({ title: "Original backup API paper", classification: {}, confidence: {}, evidence: {} });
    repo.confirmDraft(draftId);

    assert.equal((await fetch(`${baseUrl}/api/backups`, { method: "GET" })).status, 200);
    const invalidType = await fetch(`${baseUrl}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "unknown" })
    });
    assert.equal(invalidType.status, 400);

    const created = await fetch(`${baseUrl}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "database" })
    });
    assert.equal(created.status, 201);
    const record = await created.json();
    assert.deepEqual(Object.keys(record).sort(), ["backupType", "createdAt", "id", "sizeBytes"].sort());
    assert.equal(record.backupType, "database");

    const missingConfirmation = await fetch(`${baseUrl}/api/backups/${record.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(missingConfirmation.status, 400);

    repo.createDraft({ title: "Changed backup API paper", classification: {}, confidence: {}, evidence: {} });
    const restored = await fetch(`${baseUrl}/api/backups/${record.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(restored.status, 200);
    assert.equal(new PaperRepository(dbPath).searchPapers()[0].title, "Original backup API paper");

    const backupNames = await readdir(backupsDir);
    let backupDirectory;
    for (const name of backupNames) {
      const candidate = path.join(backupsDir, name, "manifest.json");
      try {
        if (JSON.parse(await readFile(candidate, "utf8")).createdAt === record.createdAt) {
          backupDirectory = path.dirname(candidate);
          break;
        }
      } catch {
        // Ignore non-backup entries while locating the selected record.
      }
    }
    assert.ok(backupDirectory);
    const manifestPath = path.join(backupDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].sha256 = "bad-hash";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const invalidManifest = await fetch(`${baseUrl}/api/backups/${record.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(invalidManifest.status, 400);
  });
});

test("backup API rejects a stored path outside the backup root", async () => {
  await withServer(async (baseUrl, { dbPath, dir }) => {
    const created = await fetch(`${baseUrl}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "database" })
    });
    const record = await created.json();
    const db = openDb(dbPath);
    try {
      db.prepare("UPDATE backup_records SET stored_path = ? WHERE id = ?").run(path.join(dir, "outside"), record.id);
    } finally {
      db.close();
    }

    const response = await fetch(`${baseUrl}/api/backups/${record.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.stringify(await response.json()).includes(dir), false);
  });
});

test("API omits internal file fields from draft and paper responses", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "public.pdf", text: "Public response paper" })
    });
    const draft = await createResponse.json();
    const pending = await (await fetch(`${baseUrl}/api/drafts`)).json();
    for (const body of [draft, pending[0]]) {
      assert.equal("storedFilename" in body, false);
      assert.equal("storedPath" in body, false);
      assert.equal("fileSha256" in body, false);
      assert.equal("paperFiles" in body, false);
    }

    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: draft.title })
    });
    const paper = await confirmResponse.json();
    const papers = await (await fetch(`${baseUrl}/api/papers`)).json();
    for (const body of [paper, papers[0]]) {
      assert.equal("storedFilename" in body, false);
      assert.equal("storedPath" in body, false);
      assert.equal("fileSha256" in body, false);
      assert.equal("paperFiles" in body, false);
    }
  });
});

test("API returns 404 for confirming a missing draft", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/drafts/999999/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Draft not found" });
  });
});

test("API paper merge requires confirmation and creates a backup before success", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const createPaper = (title) => repo.confirmDraft(repo.createDraft({ title, classification: {}, confidence: {}, evidence: {} }));
    const targetId = createPaper("API target");
    const sourceId = createPaper("API source");

    const missingConfirmation = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: sourceId })
    });
    assert.equal(missingConfirmation.status, 400);

    const merged = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: sourceId, confirm: true })
    });
    assert.equal(merged.status, 200);
    assert.equal((await merged.json()).id, targetId);
    assert.equal(repo.searchPapers().length, 1);
    const backups = repo.listBackupRecords();
    assert.equal(backups.length, 1);
    const db = openDb(dbPath);
    try {
      const log = db.prepare("SELECT backup_record_id FROM paper_merge_log WHERE target_paper_id = ?").get(targetId);
      assert.equal(log.backup_record_id, backups[0].id);
    } finally {
      db.close();
    }
    const backupDb = openDb(path.join(backups[0].storedPath, "library.sqlite"));
    try {
      assert.equal(backupDb.prepare("SELECT COUNT(*) AS count FROM paper_merge_log").get().count, 0);
      assert.equal(backupDb.prepare("SELECT deleted_at FROM papers WHERE id = ?").get(sourceId).deleted_at, null);
    } finally {
      backupDb.close();
    }
  });
});

test("API merge returns 400, 404, and 409 for invalid paper merge states", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const createPaper = (title) => repo.confirmDraft(repo.createDraft({ title, classification: {}, confidence: {}, evidence: {} }));
    const targetId = createPaper("Error target");
    const sourceId = createPaper("Error source");

    const same = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: targetId, confirm: true })
    });
    assert.equal(same.status, 400);

    const missing = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: 999999, confirm: true })
    });
    assert.equal(missing.status, 404);

    repo.trashPaper(sourceId);
    const trashed = await fetch(`${baseUrl}/api/papers/${targetId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaperId: sourceId, confirm: true })
    });
    assert.equal(trashed.status, 409);
  });
});

test("API draft merge validates pending and active states and does not create a second paper", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const targetId = repo.confirmDraft(repo.createDraft({ title: "Draft merge target", classification: {}, confidence: {}, evidence: {} }));
    const draftId = repo.createDraft({ title: "Duplicate draft", storedPath: "2026/duplicate.pdf", classification: {}, confidence: {}, evidence: {} });

    const missingConfirmation = await fetch(`${baseUrl}/api/drafts/${draftId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetPaperId: targetId })
    });
    assert.equal(missingConfirmation.status, 400);

    const merged = await fetch(`${baseUrl}/api/drafts/${draftId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetPaperId: targetId, confirm: true })
    });
    assert.equal(merged.status, 200);
    assert.equal((await merged.json()).id, targetId);
    assert.equal(repo.searchPapers().length, 1);
    assert.equal(repo.getDraft(draftId).status, "merged");
    assert.equal(repo.listBackupRecords().length, 1);

    const repeated = await fetch(`${baseUrl}/api/drafts/${draftId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetPaperId: targetId, confirm: true })
    });
    assert.equal(repeated.status, 409);
  });
});

test("API stores same-name same-millisecond uploads separately with correct hashes", async () => {
  await withServer(
    async (baseUrl, { dbPath, filesDir }) => {
      const firstBody = "%PDF-1.4\nfirst upload\n%%EOF";
      const secondBody = "%PDF-1.4\nsecond upload\n%%EOF";
      const form = new FormData();
      form.append("files", new Blob([firstBody], { type: "application/pdf" }), "same-name.pdf");
      form.append("files", new Blob([secondBody], { type: "application/pdf" }), "same-name.pdf");

      const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      assert.equal(response.status, 201);
      const drafts = await response.json();
      assert.equal(drafts.length, 2);
      assert.equal("storedPath" in drafts[0], false);
      assert.equal("fileSha256" in drafts[0], false);

      const db = openDb(dbPath);
      let rows;
      try {
        rows = db.prepare(
          "SELECT stored_path, file_sha256 FROM drafts ORDER BY id ASC"
        ).all();
      } finally {
        db.close();
      }
      assert.equal(new Set(rows.map((row) => row.stored_path)).size, 2);
      assert.deepEqual(rows.map((row) => row.file_sha256), [
        fingerprintBuffer(Buffer.from(firstBody)),
        fingerprintBuffer(Buffer.from(secondBody))
      ]);
      assert.deepEqual((await readdir(path.join(filesDir, String(new Date().getFullYear())))).sort(),
        rows.map((row) => path.basename(row.stored_path)).sort());
      assert.deepEqual(await Promise.all(rows.map((row) => readFile(path.resolve(row.stored_path)))), [
        Buffer.from(firstBody),
        Buffer.from(secondBody)
      ]);
    },
    {
      enableUploadLookup: false,
      now: () => 1_700_000_000_000,
      extractPdfText: async (filePath) => `Same-name upload ${path.basename(filePath)}`
    }
  );
});

test("API compensates every upload artifact when a later file fails", async () => {
  await withServer(
    async (baseUrl, { dbPath, filesDir, dir }) => {
      const db = openDb(dbPath);
      try {
        db.exec(`
          CREATE TRIGGER reject_second_upload BEFORE INSERT ON drafts
          WHEN NEW.original_filename = 'second.pdf'
          BEGIN SELECT RAISE(ABORT, 'second upload failed'); END;
        `);
      } finally {
        db.close();
      }

      const form = new FormData();
      form.append("files", new Blob(["%PDF-1.4\nfirst\n%%EOF"], { type: "application/pdf" }), "first.pdf");
      form.append("files", new Blob(["%PDF-1.4\nsecond\n%%EOF"], { type: "application/pdf" }), "second.pdf");

      const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      const body = await response.json();
      assert.equal(response.status, 500);
      assert.deepEqual(body, { error: "服务器内部错误" });
      assert.equal(JSON.stringify(body).includes(dir), false);

      const afterFailure = openDb(dbPath);
      try {
        assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM drafts").get().count, 0);
        assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM paper_files").get().count, 0);
      } finally {
        afterFailure.close();
      }
      const yearDir = path.join(filesDir, String(new Date().getFullYear()));
      assert.deepEqual(await readdir(yearDir), []);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => "Upload paper"
    }
  );
});

test("API sanitizes unknown global errors", async () => {
  await withServer(async (baseUrl, { dbPath, dir }) => {
    const db = openDb(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER leak_error BEFORE INSERT ON drafts
        BEGIN SELECT RAISE(ABORT, 'database failure at ${dir.replaceAll("'", "''")}\\private.sqlite'); END;
      `);
    } finally {
      db.close();
    }

    const response = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "error.txt", text: "Trigger error" })
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: "服务器内部错误" });
    assert.equal(JSON.stringify(body).includes(dir), false);
  });
});

test("API edits confirmed paper metadata and notes with conflict protection", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "edit.pdf", text: "Original paper title\nAbstract\nEdit test." })
    });
    const draft = await createResponse.json();
    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Original title" })
    });
    const paper = await confirmResponse.json();

    const noopResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: paper.version })
    });
    assert.equal(noopResponse.status, 400);
    const papersAfterNoop = await (await fetch(`${baseUrl}/api/papers`)).json();
    const unchanged = papersAfterNoop.find((item) => item.id === paper.id);
    assert.equal(unchanged.version, paper.version);
    assert.equal(unchanged.updatedAt, paper.updatedAt);

    const emptyNotesResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/notes`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: paper.version })
    });
    assert.equal(emptyNotesResponse.status, 400);
    const papersAfterEmptyNotes = await (await fetch(`${baseUrl}/api/papers`)).json();
    const unchangedAfterEmptyNotes = papersAfterEmptyNotes.find((item) => item.id === paper.id);
    assert.equal(unchangedAfterEmptyNotes.version, paper.version);
    assert.equal(unchangedAfterEmptyNotes.updatedAt, paper.updatedAt);

    const editResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        title: "Edited title",
        version: 99,
        storedPath: "outside/library.pdf",
        fileSha256: "mutated",
        deletedAt: "2026-01-01",
        mergedIntoId: 42
      })
    });
    assert.equal(editResponse.status, 200);
    const edited = await editResponse.json();
    assert.equal(edited.version, 2);
    assert.equal(edited.title, "Edited title");
    assert.equal("storedPath" in edited, false);
    assert.equal("fileSha256" in edited, false);
    assert.equal(edited.deletedAt, null);
    assert.equal(edited.mergedIntoId, null);

    const staleResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, title: "Stale title" })
    });
    assert.equal(staleResponse.status, 409);

    const notesResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/notes`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, notesPersonal: "Autosaved note", title: "Blocked" })
    });
    assert.equal(notesResponse.status, 200);
    const noted = await notesResponse.json();
    assert.equal(noted.notesPersonal, "Autosaved note");
    assert.equal(noted.title, "Edited title");
    assert.equal(noted.version, 3);
  });
});

test("API validates confirmed paper edits", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "validation.pdf", text: "Validation paper" })
    });
    const draft = await createResponse.json();
    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Validation paper" })
    });
    const paper = await confirmResponse.json();

    for (const body of [
      { expectedVersion: 0, title: "Invalid version" },
      { expectedVersion: 1, title: " " },
      { expectedVersion: 1, year: "2026" },
      { expectedVersion: 1, authors: "One Author" }
    ]) {
      const response = await fetch(`${baseUrl}/api/papers/${paper.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
    }

    const missingResponse = await fetch(`${baseUrl}/api/papers/999999`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, title: "Missing" })
    });
    assert.equal(missingResponse.status, 404);
  });
});

test("API falls back to decoded filename when extracted PDF text is sparse", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "æ²³åå¹³åç¬¬åçºªå°è´¨æ¼åä¸ç¯å¢åè¿.pdf",
        text: "\n\n\n\n\n\n\n"
      })
    });

    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();
    assert.equal(draft.title, "河南平原第四纪地质演化与环境变迁");
    assert.deepEqual(draft.classification.regions, ["Henan Plain"]);
    assert.deepEqual(draft.classification.periods, ["Quaternary"]);
    assert.match(draft.abstract, /扫描版/);
  });
});

test("API enriches sparse uploaded PDF text with OCR output", async () => {
  let ocrCalled = false;

  await withServer(
    async (baseUrl) => {
      const form = new FormData();
      form.append("files", new Blob(["fake pdf"], { type: "application/pdf" }), "scan.pdf");

      const createResponse = await fetch(`${baseUrl}/api/uploads`, {
        method: "POST",
        body: form
      });

      assert.equal(createResponse.status, 201);
      const [draft] = await createResponse.json();
      assert.equal(ocrCalled, true);
      assert.equal(draft.title, "Late Quaternary evolution of the Henan Plain");
      assert.ok(draft.classification.regions.includes("Henan Plain"));
      assert.ok(draft.extractedText.includes("optical character recognition"));
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => "\n\n\n",
      extractOcrText: async () => {
        ocrCalled = true;
        return {
          used: true,
          reason: "",
          pages: 1,
          text: `
            Late Quaternary evolution of the Henan Plain
            Abstract
            This scanned paper uses optical character recognition to identify Quaternary
            geological evolution in the Henan Plain from regional sediment records.
            Keywords: Quaternary; Henan Plain; OCR
            Introduction
          `
        };
      }
    }
  );
});

test("API prefers OCR text when PDF text extraction fails", async () => {
  await withServer(
    async (baseUrl) => {
      const form = new FormData();
      form.append("files", new Blob(["fake pdf"], { type: "application/pdf" }), "scan.pdf");

      const createResponse = await fetch(`${baseUrl}/api/uploads`, {
        method: "POST",
        body: form
      });

      assert.equal(createResponse.status, 201);
      const [draft] = await createResponse.json();
      assert.equal(draft.title, "Scanned Quaternary record from the Yellow River Basin");
      assert.notEqual(draft.title, "PDF text extraction failed: invalid pdf");
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => {
        throw new Error("invalid pdf");
      },
      extractOcrText: async () => ({
        used: true,
        reason: "",
        pages: 1,
        text: `
          Scanned Quaternary record from the Yellow River Basin
          Abstract
          Optical character recognition recovered enough text for metadata parsing.
          Keywords: Quaternary; Yellow River basin
          Introduction
        `
      })
    }
  );
});

test("API serves the source PDF for a confirmed paper", async () => {
  await withServer(
    async (baseUrl) => {
      const pdfBody = "%PDF-1.4\nsource file\n%%EOF";
      const form = new FormData();
      form.append("files", new Blob([pdfBody], { type: "application/pdf" }), "source.pdf");

      const uploadResponse = await fetch(`${baseUrl}/api/uploads`, {
        method: "POST",
        body: form
      });
      assert.equal(uploadResponse.status, 201);
      const [draft] = await uploadResponse.json();

      const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: draft.title })
      });
      assert.equal(confirmResponse.status, 201);
      const paper = await confirmResponse.json();

      const fileResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/file`);
      assert.equal(fileResponse.status, 200);
      assert.match(fileResponse.headers.get("content-type"), /^application\/pdf/);
      assert.equal(await fileResponse.text(), pdfBody);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => `
        Source PDF test paper
        Abstract
        This paper tests source file reading in the Quaternary paper library.
        Keywords: Quaternary
        Introduction
      `
    }
  );
});

test("API returns 404 when a confirmed paper has no source file", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "paper.txt",
        text: "Paper without source file\nAbstract\nThis record has metadata but no PDF file."
      })
    });
    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();

    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: draft.title })
    });
    assert.equal(confirmResponse.status, 201);
    const paper = await confirmResponse.json();

    const fileResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/file`);
    assert.equal(fileResponse.status, 404);
  });
});

test("API sanitizes PDF extractor errors before storing or returning draft text", async () => {
  const absolutePath = path.join(os.tmpdir(), "qpl-private", "failed-extraction.pdf");
  await withServer(
    async (baseUrl, { dbPath, dir }) => {
      const form = new FormData();
      form.append("files", new Blob(["fake pdf"], { type: "application/pdf" }), "failed.pdf");

      const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      assert.equal(response.status, 201);
      const [draft] = await response.json();
      assert.equal(draft.extractedText.includes(absolutePath), false);
      assert.equal(JSON.stringify(draft).includes(dir), false);

      const db = openDb(dbPath);
      try {
        const row = db.prepare("SELECT extracted_text FROM drafts WHERE id = ?").get(draft.id);
        assert.equal(row.extracted_text.includes(absolutePath), false);
      } finally {
        db.close();
      }
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => {
        throw new Error(`cannot read ${absolutePath}`);
      },
      extractOcrText: async () => ({ text: "" })
    }
  );
});

test("API detects exact and DOI duplicates while allowing separate confirmation", async () => {
  await withServer(
    async (baseUrl) => {
      const upload = async (bytes, filename) => {
        const form = new FormData();
        form.append("files", new Blob([bytes], { type: "application/pdf" }), filename);
        const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
        assert.equal(response.status, 201);
        return (await response.json())[0];
      };

      const first = await upload("%PDF-1.4\nfirst\n%%EOF", "first.pdf");
      const firstConfirm = await fetch(`${baseUrl}/api/drafts/${first.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: first.title })
      });
      assert.equal(firstConfirm.status, 201);

      const sameBytes = await upload("%PDF-1.4\nfirst\n%%EOF", "same.pdf");
      assert.equal(sameBytes.duplicateCandidates[0].reason, "sha256");
      assert.equal(sameBytes.duplicateCandidates[0].score, 1);
      const sameConfirm = await fetch(`${baseUrl}/api/drafts/${sameBytes.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: sameBytes.title })
      });
      assert.equal(sameConfirm.status, 201);

      const differentBytes = await upload("%PDF-1.4\nsecond\n%%EOF", "different.pdf");
      assert.equal(differentBytes.duplicateCandidates[0].reason, "doi");
      assert.equal(differentBytes.duplicateCandidates[0].score, 1);

      const papers = await (await fetch(`${baseUrl}/api/papers`)).json();
      assert.equal(papers.length, 2);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => `
        Holocene lake sediment record
        DOI: 10.1000/duplicate.
        Abstract
        A duplicate detection test paper.
        Year: 2020
      `
    }
  );
});

test("API scans only safe active PDF files and returns duplicate groups", async () => {
  await withServer(async (baseUrl, { dbPath, filesDir, dir }) => {
    const insidePath = path.join(filesDir, "2026", "scan.pdf");
    const outsidePath = path.join(dir, "outside.pdf");
    await mkdir(path.dirname(insidePath), { recursive: true });
    await writeFile(insidePath, "%PDF-1.4\nscan\n%%EOF");
    await writeFile(outsidePath, "%PDF-1.4\noutside\n%%EOF");

    const repo = new PaperRepository(dbPath);
    const insideDraft = repo.createDraft({
      storedPath: insidePath,
      storedFilename: "scan.pdf",
      doi: "10.1000/scan",
      title: "Scanned paper",
      year: 2020,
      classification: {},
      confidence: {},
      evidence: {}
    });
    const outsideDraft = repo.createDraft({
      storedPath: outsidePath,
      storedFilename: "outside.pdf",
      doi: "10.1000/outside",
      title: "Outside paper",
      year: 2020,
      classification: {},
      confidence: {},
      evidence: {}
    });
    const insidePaperId = repo.confirmDraft(insideDraft);
    const outsidePaperId = repo.confirmDraft(outsideDraft);

    const scanResponse = await fetch(`${baseUrl}/api/duplicates/scan`, { method: "POST" });
    assert.equal(scanResponse.status, 200);
    const scan = await scanResponse.json();
    assert.ok(scan.scanned.includes("2026/scan.pdf"));
    assert.equal(scan.rejected.length, 1);
    assert.equal(JSON.stringify(scan).includes(dir), false);
    assert.equal(scan.groups.sha256.length, 0);

    const db = openDb(dbPath);
    try {
      assert.equal(db.prepare("SELECT file_sha256 FROM papers WHERE id = ?").get(insidePaperId).file_sha256,
        "cc446fe332e4e71dc69b9a448bfdebd952ec396489a6edebe4665eea448ad985");
      assert.equal(db.prepare("SELECT file_sha256 FROM papers WHERE id = ?").get(outsidePaperId).file_sha256, "");
    } finally {
      db.close();
    }

    const latestResponse = await fetch(`${baseUrl}/api/duplicates`);
    assert.equal(latestResponse.status, 200);
    const latest = await latestResponse.json();
    assert.deepEqual(latest.groups, scan.groups);
  });
});

test("API abandons only confirmed pending draft deletions and cleans safe files", async () => {
  await withServer(async (baseUrl, { filesDir }) => {
    const storedPath = path.join(filesDir, "2026", "abandon.pdf");
    await mkdir(path.dirname(storedPath), { recursive: true });
    await writeFile(storedPath, "%PDF-1.4\nabandon\n%%EOF");

    const repo = new PaperRepository(path.join(path.dirname(filesDir), "library.sqlite"));
    const pendingId = repo.createDraft({ storedPath, storedFilename: "abandon.pdf", title: "Abandon me" });
    const confirmedId = repo.createDraft({ title: "Keep me" });
    repo.confirmDraft(confirmedId);

    const missingConfirm = await fetch(`${baseUrl}/api/drafts/${pendingId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(missingConfirm.status, 400);

    const deleted = await fetch(`${baseUrl}/api/drafts/${pendingId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(deleted.status, 200);
    await assert.rejects(access(storedPath));

    const protectedDelete = await fetch(`${baseUrl}/api/drafts/${confirmedId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(protectedDelete.status, 409);
  });
});

test("GET duplicates groups active secondary hashes into one deterministic group", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const createPaper = (fileSha256, title) => repo.confirmDraft(repo.createDraft({
      fileSha256,
      title,
      classification: {},
      confidence: {},
      evidence: {}
    }));
    const firstPaperId = createPaper("representative-first", "First paper");
    const secondPaperId = createPaper("representative-second", "Second paper");

    const db = openDb(dbPath);
    try {
      const insertFile = db.prepare(`
        INSERT INTO paper_files (paper_id, stored_filename, stored_path, sha256, status)
        VALUES (?, ?, ?, ?, ?)
      `);
      insertFile.run(firstPaperId, "first-secondary.pdf", "2026/first-secondary.pdf", "shared-hash", "active");
      insertFile.run(firstPaperId, "first-secondary-copy.pdf", "2026/first-secondary-copy.pdf", "shared-hash", "active");
      insertFile.run(secondPaperId, "second-secondary.pdf", "2026/second-secondary.pdf", "shared-hash", "active");
      insertFile.run(secondPaperId, "second-trash.pdf", "2026/second-trash.pdf", "shared-hash", "trash");
    } finally {
      db.close();
    }

    const response = await fetch(`${baseUrl}/api/duplicates`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.groups.sha256, [
      { sha256: "shared-hash", paperIds: [firstPaperId, secondPaperId] }
    ]);
  });
});

test("API trashes, restores, and purges a paper with explicit confirmation", async () => {
  await withServer(
    async (baseUrl) => {
      const pdfBody = "%PDF-1.4\nrecycle bin source\n%%EOF";
      const form = new FormData();
      form.append("files", new Blob([pdfBody], { type: "application/pdf" }), "recycle.pdf");
      const uploadResponse = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      assert.equal(uploadResponse.status, 201);
      const [draft] = await uploadResponse.json();

      const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: draft.title })
      });
      const paper = await confirmResponse.json();

      assert.equal((await fetch(`${baseUrl}/api/papers/999999`, { method: "DELETE" })).status, 404);
      const trashResponse = await fetch(`${baseUrl}/api/papers/${paper.id}`, { method: "DELETE" });
      assert.equal(trashResponse.status, 200);
      assert.equal((await (await fetch(`${baseUrl}/api/papers`)).json()).length, 0);
      assert.equal((await (await fetch(`${baseUrl}/api/trash`)).json())[0].id, paper.id);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 200);

      const missingConfirm = await fetch(`${baseUrl}/api/trash/${paper.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(missingConfirm.status, 400);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 200);

      assert.equal((await fetch(`${baseUrl}/api/trash/999999/restore`, { method: "POST" })).status, 404);
      const restoreResponse = await fetch(`${baseUrl}/api/trash/${paper.id}/restore`, { method: "POST" });
      assert.equal(restoreResponse.status, 200);
      assert.equal((await (await fetch(`${baseUrl}/api/papers`)).json())[0].id, paper.id);

      await fetch(`${baseUrl}/api/papers/${paper.id}`, { method: "DELETE" });
      const purgeResponse = await fetch(`${baseUrl}/api/trash/${paper.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(purgeResponse.status, 200);
      const purgeBody = await purgeResponse.json();
      assert.ok(purgeBody.cleanup);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/trash/${paper.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      })).status, 404);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => "Recycle bin source paper\nAbstract\nA source file for recycle bin tests."
    }
  );
});

test("API purges every trashed paper only after full-bin confirmation", async () => {
  await withServer(
    async (baseUrl) => {
      const form = new FormData();
      form.append("files", new Blob(["%PDF-1.4\nfull bin\n%%EOF"], { type: "application/pdf" }), "full-bin.pdf");
      const uploadResponse = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
      const [draft] = await uploadResponse.json();
      const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: draft.title })
      });
      const paper = await confirmResponse.json();
      await fetch(`${baseUrl}/api/papers/${paper.id}`, { method: "DELETE" });

      const missingConfirm = await fetch(`${baseUrl}/api/trash`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(missingConfirm.status, 400);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 200);

      const purgeResponse = await fetch(`${baseUrl}/api/trash`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(purgeResponse.status, 200);
      assert.equal((await fetch(`${baseUrl}/api/papers/${paper.id}/file`)).status, 404);
      assert.deepEqual(await (await fetch(`${baseUrl}/api/trash`)).json(), []);
    },
    {
      enableUploadLookup: false,
      extractPdfText: async () => "Full bin source paper\nAbstract\nA source file for full-bin purge tests."
    }
  );
});

test("API rejects symlink or junction traversal for reads and purge", async () => {
  await withServer(async (baseUrl, { dbPath, dir, filesDir }) => {
    const outsideDir = path.join(dir, "outside");
    const linkedDir = path.join(filesDir, "linked");
    const victimPath = path.join(outsideDir, "victim.pdf");
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    await writeFile(victimPath, "%PDF-1.4 outside victim");

    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({
      storedPath: path.join(linkedDir, "victim.pdf"),
      storedFilename: "victim.pdf",
      title: "Linked victim paper",
      classification: {},
      confidence: {},
      evidence: {}
    });
    const paperId = repo.confirmDraft(draftId);

    assert.equal((await fetch(`${baseUrl}/api/papers/${paperId}/file`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/papers/${paperId}`, { method: "DELETE" })).status, 200);
    const purgeResponse = await fetch(`${baseUrl}/api/trash/${paperId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(purgeResponse.status, 200);
    const purgeBody = await purgeResponse.json();
    assert.deepEqual(purgeBody.cleanup.removed, []);
    assert.equal(purgeBody.cleanup.rejected.length, 1);
    assert.ok(!JSON.stringify(purgeBody).includes(filesDir));
    await access(victimPath);
  });
});

test("Task 4 responses omit absolute and internal paper storage fields", async () => {
  await withServer(async (baseUrl, { dbPath, dir }) => {
    const absoluteStoredPath = path.join(dir, "private", "absolute.pdf");
    const secondStoredPath = path.join(dir, "private", "second.pdf");
    const repo = new PaperRepository(dbPath);

    const createPaper = (storedPath, title) => {
      const draftId = repo.createDraft({
        storedPath,
        storedFilename: path.basename(storedPath),
        fileSha256: "private-hash",
        title,
        year: 2026,
        classification: {},
        confidence: {},
        evidence: {}
      });
      return repo.confirmDraft(draftId);
    };
    const firstPaperId = createPaper(absoluteStoredPath, "Private path paper");
    const secondPaperId = createPaper(secondStoredPath, "Second private path paper");
    const publicKeys = ["deletedAt", "id", "status", "title", "version", "year"].sort();

    const assertPublicPaperBody = (body, expectedStatus) => {
      assert.deepEqual(Object.keys(body).sort(), publicKeys);
      assert.equal(body.status, expectedStatus);
      assert.equal(JSON.stringify(body).includes(absoluteStoredPath), false);
      return body;
    };
    const assertPublicPaper = async (response, expectedStatus) => {
      assert.equal(response.status, 200);
      return assertPublicPaperBody(await response.json(), expectedStatus);
    };

    await assertPublicPaper(
      await fetch(`${baseUrl}/api/papers/${firstPaperId}`, { method: "DELETE" }),
      "trash"
    );
    await assertPublicPaper(
      await fetch(`${baseUrl}/api/papers/${secondPaperId}`, { method: "DELETE" }),
      "trash"
    );

    const trashResponse = await fetch(`${baseUrl}/api/trash`);
    assert.equal(trashResponse.status, 200);
    const trashPapers = await trashResponse.json();
    assert.equal(trashPapers.length, 2);
    for (const paper of trashPapers) {
      assert.deepEqual(Object.keys(paper).sort(), publicKeys);
      assert.equal(paper.status, "trash");
      assert.equal(JSON.stringify(paper).includes(absoluteStoredPath), false);
    }

    await assertPublicPaper(
      await fetch(`${baseUrl}/api/trash/${firstPaperId}/restore`, { method: "POST" }),
      "active"
    );
    await assertPublicPaper(
      await fetch(`${baseUrl}/api/papers/${firstPaperId}`, { method: "DELETE" }),
      "trash"
    );

    const individualPurgeResponse = await fetch(`${baseUrl}/api/trash/${firstPaperId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(individualPurgeResponse.status, 200);
    const individualPurgeBody = await individualPurgeResponse.json();
    assertPublicPaperBody(individualPurgeBody.paper, "trash");
    assert.equal(JSON.stringify(individualPurgeBody).includes(absoluteStoredPath), false);

    const fullPurgeResponse = await fetch(`${baseUrl}/api/trash`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(fullPurgeResponse.status, 200);
    const fullPurgeBody = await fullPurgeResponse.json();
    assert.equal(fullPurgeBody.papers.length, 1);
    assert.deepEqual(Object.keys(fullPurgeBody.papers[0]).sort(), publicKeys);
    assert.equal(fullPurgeBody.papers[0].status, "trash");
    assert.equal(JSON.stringify(fullPurgeBody).includes(absoluteStoredPath), false);
  });
});

test("API returns 409 when editing trashed or merged papers", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const createPaper = (title) => {
      const draftId = repo.createDraft({ title, classification: {}, confidence: {}, evidence: {} });
      return repo.confirmDraft(draftId);
    };
    const trashedId = createPaper("Trashed API paper");
    assert.equal((await fetch(`${baseUrl}/api/papers/${trashedId}`, { method: "DELETE" })).status, 200);

    const trashedEdit = await fetch(`${baseUrl}/api/papers/${trashedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, title: "Blocked" })
    });
    assert.equal(trashedEdit.status, 409);
    assert.match((await trashedEdit.json()).error, /active before editing/);

    const trashedProgress = await fetch(`${baseUrl}/api/papers/${trashedId}/reading-progress`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastReadPage: 2 })
    });
    assert.equal(trashedProgress.status, 409);
    assert.match((await trashedProgress.json()).error, /active before updating reading progress/);

    const mergedId = createPaper("Merged API paper");
    const db = openDb(dbPath);
    try {
      db.prepare("UPDATE papers SET deleted_at = CURRENT_TIMESTAMP, merged_into_id = 999 WHERE id = ?").run(mergedId);
    } finally {
      db.close();
    }

    const mergedEdit = await fetch(`${baseUrl}/api/papers/${mergedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, title: "Blocked merged edit" })
    });
    assert.equal(mergedEdit.status, 409);
    assert.match((await mergedEdit.json()).error, /active before editing/);

    const mergedPurge = await fetch(`${baseUrl}/api/trash/${mergedId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(mergedPurge.status, 409);
    assert.match((await mergedPurge.json()).error, /cannot be purged/);

    const mergedFullPurge = await fetch(`${baseUrl}/api/trash`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(mergedFullPurge.status, 200);
    assert.deepEqual((await mergedFullPurge.json()).papers.map((paper) => paper.id), [trashedId]);
    assert.equal(repo.getPaper(mergedId).mergedIntoId, 999);
  });
});

test("API saves reading progress and exposes it in paper list", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/drafts/from-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "reader.pdf",
        text: "Reader progress paper\nAbstract\nThis record tests reader bookmarks."
      })
    });
    assert.equal(createResponse.status, 201);
    const draft = await createResponse.json();

    const confirmResponse = await fetch(`${baseUrl}/api/drafts/${draft.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: draft.title })
    });
    assert.equal(confirmResponse.status, 201);
    const paper = await confirmResponse.json();

    const lastReadResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/reading-progress`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastReadPage: 4 })
    });
    assert.equal(lastReadResponse.status, 200);
    let updated = await lastReadResponse.json();
    assert.equal(updated.lastReadPage, 4);
    assert.equal(updated.bookmarkPage, null);

    const bookmarkResponse = await fetch(`${baseUrl}/api/papers/${paper.id}/reading-progress`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkPage: 7 })
    });
    assert.equal(bookmarkResponse.status, 200);
    updated = await bookmarkResponse.json();
    assert.equal(updated.lastReadPage, 4);
    assert.equal(updated.bookmarkPage, 7);

    const listResponse = await fetch(`${baseUrl}/api/papers`);
    const papers = await listResponse.json();
    assert.equal(papers[0].lastReadPage, 4);
    assert.equal(papers[0].bookmarkPage, 7);
  });
});

test("API translation is disabled unless explicitly enabled", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /翻译功能未启用/);
    },
    { translationEnabled: false }
  );
});

test("API translation requires an OpenAI API key", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /OPENAI_API_KEY/);
    },
    { translationEnabled: true, openaiApiKey: "" }
  );
});

test("API Gemini translation requires a Gemini API key", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /GEMINI_API_KEY/);
    },
    { translationEnabled: true, translationProvider: "gemini", geminiApiKey: "" }
  );
});

test("API Qwen translation requires a Qwen API key", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /QWEN_API_KEY/);
    },
    { translationEnabled: true, translationProvider: "qwen", qwenApiKey: "" }
  );
});

test("API translation returns provider result", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "The loess-paleosol sequence records river integration.",
          targetLanguage: "zh-CN"
        })
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.translatedText, "黄土-古土壤序列记录了河流贯通过程。");
      assert.equal(body.provider, "openai");
    },
    {
      translationEnabled: true,
      openaiApiKey: "test-key",
      translationModel: "test-model",
      translationFetch: async (url, options) => {
        assert.equal(url, "https://api.openai.com/v1/responses");
        assert.equal(options.method, "POST");
        assert.equal(options.headers.authorization, "Bearer test-key");
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, "test-model");
        assert.match(JSON.stringify(payload.input), /loess-paleosol/);
        return new Response(JSON.stringify({ output_text: "黄土-古土壤序列记录了河流贯通过程。" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
  );
});

test("API Gemini translation returns provider result", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "The loess-paleosol sequence records river integration.",
          targetLanguage: "zh-CN"
        })
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.translatedText, "黄土-古土壤序列记录了河流贯通过程。");
      assert.equal(body.provider, "gemini");
    },
    {
      translationEnabled: true,
      translationProvider: "gemini",
      geminiApiKey: "test-gemini-key",
      geminiModel: "gemini-test-model",
      translationFetch: async (url, options) => {
        assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent");
        assert.equal(options.method, "POST");
        assert.equal(options.headers["x-goog-api-key"], "test-gemini-key");
        const payload = JSON.parse(options.body);
        assert.match(payload.contents[0].parts[0].text, /loess-paleosol/);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "黄土-古土壤序列记录了河流贯通过程。" }]
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
    }
  );
});

test("API Qwen translation returns provider result", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "The loess-paleosol sequence records river integration.",
          targetLanguage: "zh-CN"
        })
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.translatedText, "Qwen provider translation");
      assert.equal(body.provider, "qwen");
    },
    {
      translationEnabled: true,
      translationProvider: "qwen",
      qwenApiKey: "test-qwen-key",
      qwenModel: "qwen-test-model",
      qwenBaseUrl: "https://example.aliyuncs.com/compatible-mode/v1",
      translationFetch: async (url, options) => {
        assert.equal(url, "https://example.aliyuncs.com/compatible-mode/v1/chat/completions");
        assert.equal(options.method, "POST");
        assert.equal(options.headers.authorization, "Bearer test-qwen-key");
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, "qwen-test-model");
        assert.match(payload.messages[1].content, /loess-paleosol/);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Qwen provider translation" } }]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
    }
  );
});

test("API translation falls back from Qwen to DeepSeek once", async () => {
  const requests = [];
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Short text.", targetLanguage: "zh-CN" })
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        translatedText: "短文本。",
        provider: "deepseek",
        model: "deepseek-v4-flash"
      });
      assert.equal(requests.length, 2);
      assert.match(requests[0].url, /aliyuncs/);
      assert.equal(requests[1].url, "https://api.deepseek.com/chat/completions");
      assert.equal(requests[1].body.model, "deepseek-v4-flash");
    },
    {
      translationEnabled: true,
      translationProvider: "qwen",
      qwenApiKey: "test-qwen-key",
      qwenBaseUrl: "https://example.aliyuncs.com/compatible-mode/v1",
      deepseekApiKey: "test-deepseek-key",
      translationFetch: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        if (url.includes("aliyuncs")) return new Response("quota exhausted", { status: 429 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "短文本。" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
  );
});

test("API translation rejects empty selections", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "   " })
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /请先在 PDF 中选中文字/);
    },
    {
      translationEnabled: true,
      openaiApiKey: "test-key"
    }
  );
});

test("API translation rejects oversized selections", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(6001) })
      });

      assert.equal(response.status, 413);
      assert.match((await response.json()).error, /选中文本过长/);
    },
    {
      translationEnabled: true,
      openaiApiKey: "test-key",
      translationFetch: async () => {
        throw new Error("provider should not be called");
      }
    }
  );
});

test("API translation maps provider failures to a clear error", async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Selected paper text." })
      });

      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /翻译服务暂时不可用/);
    },
    {
      translationEnabled: true,
      openaiApiKey: "test-key",
      translationFetch: async () =>
        new Response(JSON.stringify({ error: "provider unavailable" }), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
    }
  );
});

test("citation API preserves keys, validates status, and exports ids in request order", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const create = (title, year) => repo.confirmDraft(repo.createDraft({
      title,
      authors: ["Doe, Jane"],
      year,
      journal: "Journal",
      classification: {},
      confidence: {},
      evidence: {}
    }));
    const firstId = create("First", 2020);
    const secondId = create("Second", 2021);

    const first = (await (await fetch(`${baseUrl}/api/papers`)).json()).find((paper) => paper.id === firstId);
    assert.equal(first.citationKey, "doe2020first");
    const metadata = await fetch(`${baseUrl}/api/papers/${firstId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: first.version, volume: "7", issue: "2", pages: "10-20", publisher: "P", publicationType: "article" })
    });
    assert.equal(metadata.status, 200);
    const changed = await metadata.json();
    assert.equal(changed.citationKey, first.citationKey);
    assert.equal(changed.volume, "7");

    const verified = await fetch(`${baseUrl}/api/papers/${firstId}/citation`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: changed.version, status: "verified", citationKey: "stable-first" })
    });
    assert.equal(verified.status, 200);
    const verifiedPaper = await verified.json();
    assert.equal(verifiedPaper.citationKey, "stable-first");
    assert.equal(verifiedPaper.citationStatus, "verified");

    const exported = await fetch(`${baseUrl}/api/citations/export?format=in-text-apa&ids=${secondId},${firstId}`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type"), /text\/plain/);
    assert.match(exported.headers.get("content-disposition"), /citations-in-text-apa\.txt/);
    const body = await exported.text();
    assert.ok(body.indexOf("Doe, 2021") < body.indexOf("Doe, 2020"));

    assert.equal((await fetch(`${baseUrl}/api/citations/export?format=apa7`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/citations/export?format=apa7&ids=9999`)).status, 404);
    await fetch(`${baseUrl}/api/papers/${secondId}`, { method: "DELETE" });
    assert.equal((await fetch(`${baseUrl}/api/citations/export?format=apa7&ids=${secondId}`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/papers/nope/citation`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, status: "unverified" })
    })).status, 400);
  });
});

test("annotation and research-card API enforces page, confirmation, version, and public shape", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const paperId = repo.withDb((db) => Number(db.prepare(
      "INSERT INTO papers (title, search_text) VALUES (?, ?)"
    ).run("Annotation API paper", "annotation api paper").lastInsertRowid));
    repo.withDb((db) => {
      db.prepare(`
        INSERT INTO paper_pages (paper_id, page_number, text, text_source, character_count)
        VALUES (?, 1, ?, 'pdf', ?)
      `).run(paperId, "prefix quote suffix", "prefix quote suffix".length);
    });

    const missingPage = await fetch(`${baseUrl}/api/papers/${paperId}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageNumber: 2, kind: "highlight", quoteText: "quote" })
    });
    assert.equal(missingPage.status, 400);

    const created = await fetch(`${baseUrl}/api/papers/${paperId}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageNumber: 1,
        kind: "highlight",
        quoteText: "quote",
        color: "yellow",
        textSelector: {
          quote: "quote",
          prefix: "prefix ",
          suffix: " suffix",
          start: 7,
          end: 12,
          positionVerified: true,
          pageText: "prefix quote suffix"
        }
      })
    });
    assert.equal(created.status, 201);
    const annotation = await created.json();
    assert.equal(annotation.paperId, paperId);
    assert.equal(annotation.pageNumber, 1);
    assert.equal(annotation.version, 1);
    assert.equal("storedPath" in annotation, false);
    assert.equal(JSON.stringify(annotation).includes(dbPath), false);

    const updatedAnnotation = await fetch(`${baseUrl}/api/annotations/${annotation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, comment: "updated comment" })
    });
    assert.equal(updatedAnnotation.status, 200);
    assert.deepEqual((await updatedAnnotation.json()).textSelector, {
      quote: "quote",
      prefix: "prefix ",
      suffix: " suffix",
      start: 7,
      end: 12,
      positionVerified: true
    });

    const card = await fetch(`${baseUrl}/api/research-cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        annotationId: annotation.id,
        paperId,
        pageNumber: 1,
        quoteText: "quote",
        summary: "summary",
        personalInterpretation: "interpretation",
        themes: ["theme"],
        evidenceType: "supports"
      })
    });
    assert.equal(card.status, 201);
    const researchCard = await card.json();
    assert.equal(researchCard.annotationId, annotation.id);

    const stale = await fetch(`${baseUrl}/api/annotations/${annotation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 99, comment: "stale" })
    });
    assert.equal(stale.status, 409);

    const missingConfirmation = await fetch(`${baseUrl}/api/annotations/${annotation.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(missingConfirmation.status, 400);

    const deleted = await fetch(`${baseUrl}/api/annotations/${annotation.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(deleted.status, 200);

    const cards = await fetch(`${baseUrl}/api/research-cards?paperId=${paperId}`);
    assert.equal(cards.status, 200);
    const retainedCards = await cards.json();
    assert.equal(retainedCards[0].annotationId, null);
    assert.equal(retainedCards[0].quoteText, "quote");
  });
});

test("project API supports batch relations, evidence exports, conflicts, and confirmations", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const createPaper = (title) => repo.confirmDraft(repo.createDraft({
      title,
      authors: ["Author"],
      classification: { regions: ["North"], periods: ["Holocene"], materials: ["core"], methods: ["pollen"] },
      confidence: {},
      evidence: {}
    }));
    const firstId = createPaper("Project paper one");
    const secondId = createPaper("Project paper two");

    const created = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "API project", description: "Evidence project" })
    });
    assert.equal(created.status, 201);
    const project = await created.json();
    assert.equal(project.status, "active");

    const added = await fetch(`${baseUrl}/api/projects/${project.id}/papers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paperIds: [firstId, secondId], priority: 2, stance: "supports", projectStatus: "queued" })
    });
    assert.equal(added.status, 201);
    assert.equal((await added.json()).length, 2);
    assert.equal((await fetch(`${baseUrl}/api/projects/${project.id}/papers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paperIds: [firstId] })
    })).status, 409);

    const invalid = await fetch(`${baseUrl}/api/projects/${project.id}/papers/${firstId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 9 })
    });
    assert.equal(invalid.status, 400);

    const stale = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "stale", expectedVersion: 99 })
    });
    assert.equal(stale.status, 409);

    const evidence = await fetch(`${baseUrl}/api/projects/${project.id}/evidence?format=json`);
    assert.equal(evidence.status, 200);
    assert.equal((await evidence.json()).length, 2);
    const csv = await fetch(`${baseUrl}/api/projects/${project.id}/evidence?format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-disposition"), /project-evidence\.csv/);
    assert.match(await csv.text(), /citationKey/);
    const markdown = await fetch(`${baseUrl}/api/projects/${project.id}/evidence?format=markdown`);
    assert.equal(markdown.status, 200);
    assert.match(await markdown.text(), /Project paper one/);

    const missingDeleteConfirm = await fetch(`${baseUrl}/api/projects/${project.id}/papers/${firstId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(missingDeleteConfirm.status, 400);
    const removed = await fetch(`${baseUrl}/api/projects/${project.id}/papers/${firstId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(removed.status, 200);

    const missingProjectConfirm = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(missingProjectConfirm.status, 400);
    const deleted = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });
    assert.equal(deleted.status, 200);
    assert.equal(repo.getPaper(secondId).title, "Project paper two");
  });
});

test("search API validates parameters, applies filters, and never leaks FTS errors", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({
      title: "Loess lake sediment study",
      authors: ["Search Author"],
      classification: { regions: ["North"] },
      confidence: {},
      evidence: {}
    });
    const paperId = repo.confirmDraft(draftId);
    repo.replacePaperPages(paperId, [
      { pageNumber: 1, text: "Introduction", source: "pdf" },
      { pageNumber: 2, text: "Loess and lake sediment results", source: "pdf" }
    ]);

    const hit = await fetch(`${baseUrl}/api/search?q=loess&scope=fulltext&regions=North&page=1&pageSize=1`);
    assert.equal(hit.status, 200);
    const body = await hit.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].paperId, paperId);
    assert.equal(body.items[0].pageNumber, 2);
    assert.equal(body.items[0].matchScope, "fulltext");

    const semanticHit = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("湖泊沉积")}&scope=fulltext`);
    assert.equal(semanticHit.status, 200);
    assert.equal((await semanticHit.json()).total, 1);

    const strictMiss = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("湖泊沉积")}&scope=fulltext&semantic=0`);
    assert.equal(strictMiss.status, 200);
    assert.equal((await strictMiss.json()).total, 0);

    for (const query of [
      "scope=invalid",
      "page=0",
      "page=abc",
      "pageSize=0",
      "semantic=invalid"
    ]) {
      const response = await fetch(`${baseUrl}/api/search?q=loess&${query}`);
      assert.equal(response.status, 400);
    }

    const hostile = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('loess" OR *')}`);
    assert.equal(hostile.status, 200);
    assert.doesNotMatch(await hostile.text(), /SQLITE|near "OR"/i);

    const empty = await fetch(`${baseUrl}/api/search?q=%21%21%21`);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).items, []);
  });
});

test("terminology and paper knowledge APIs expose only local derived data", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const targetId = repo.confirmDraft(repo.createDraft({
      title: "Permafrost response", doi: "10.1000/permafrost", classification: {}, confidence: {}, evidence: {}
    }));
    const sourceId = repo.confirmDraft(repo.createDraft({
      title: "Knowledge source", classification: {}, confidence: {}, evidence: {}
    }));
    repo.replacePaperPages(sourceId, [
      { pageNumber: 1, text: "Fig. 1. Study setting.\nReferences\nSmith, J. 2020. Permafrost response. doi:10.1000/permafrost", source: "pdf" }
    ]);

    const created = await fetch(`${baseUrl}/api/terms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canonical: "permafrost", aliases: ["冻土"], category: "theme", definition: "Frozen ground" })
    });
    assert.equal(created.status, 201);
    const term = await created.json();
    assert.equal(term.canonical, "permafrost");
    assert.equal((await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("冻土")}&scope=metadata`)).status, 200);

    const rebuilt = await fetch(`${baseUrl}/api/papers/${sourceId}/knowledge/rebuild`, { method: "POST" });
    assert.equal(rebuilt.status, 200);
    assert.deepEqual(await rebuilt.json(), { references: 1, assets: 1, citationRelations: 1 });
    const knowledgeResponse = await fetch(`${baseUrl}/api/papers/${sourceId}/knowledge`);
    assert.equal(knowledgeResponse.status, 200);
    const knowledge = await knowledgeResponse.json();
    assert.equal(knowledge.references[0].matchedPaperId, targetId);
    assert.equal(knowledge.assets[0].pageNumber, 1);
    assert.equal(knowledge.relations.stored[0].targetPaperId, targetId);
    assert.doesNotMatch(JSON.stringify(knowledge), /storedPath|library\\|library\//i);

    const manualResponse = await fetch(`${baseUrl}/api/papers/${sourceId}/relations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetPaperId: targetId, relationType: "supports", reason: "Same chronology" })
    });
    assert.equal(manualResponse.status, 201);
    const manual = await manualResponse.json();
    assert.equal(manual.origin, "manual");
    assert.equal((await fetch(`${baseUrl}/api/papers/${sourceId}/relations/${manual.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    })).status, 200);

    const updated = await fetch(`${baseUrl}/api/terms/${term.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: term.version, aliases: ["冻土", "永久冻土"] })
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).version, 2);
    assert.equal((await fetch(`${baseUrl}/api/terms/${term.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true })
    })).status, 200);
  });
});

test("API reindex requires confirmation and reports indexed page sources", async () => {
  await withServer(
    async (baseUrl, { dbPath, filesDir, dir }) => {
      await mkdir(path.join(filesDir, "2026"), { recursive: true });
      await writeFile(path.join(filesDir, "2026", "source.pdf"), "generated test fixture");
      const repo = new PaperRepository(dbPath);
      const draftId = repo.createDraft({
        storedFilename: "source.pdf",
        storedPath: "2026/source.pdf",
        title: "Reindex API paper",
        classification: {}
      });
      const paperId = repo.confirmDraft(draftId);

      const missingConfirmation = await fetch(`${baseUrl}/api/papers/${paperId}/reindex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(missingConfirmation.status, 400);

      const missingPaper = await fetch(`${baseUrl}/api/papers/999999/reindex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(missingPaper.status, 404);

      const indexed = await fetch(`${baseUrl}/api/papers/${paperId}/reindex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(indexed.status, 200);
      const body = await indexed.json();
      assert.equal(body.pageCount, 2);
      assert.deepEqual(body.sources, { pdf: 1, ocr: 1, mixed: 0 });
      assert.equal(JSON.stringify(body).includes(dir), false);
    },
    {
      extractPdfPages: async () => [
        { pageNumber: 1, text: "complete PDF page", source: "pdf", language: "" },
        { pageNumber: 2, text: "short", source: "pdf", language: "" }
      ],
      extractOcrPages: async () => [
        { pageNumber: 2, text: "OCR supplements page two", source: "ocr", language: "eng" }
      ]
    }
  );
});

test("API research returns local evidence insufficiency without calling Qwen", async () => {
  let called = false;
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/research/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "No matching page" })
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        answer: "当前资料库证据不足",
        citations: []
      });
      assert.equal(called, false);
    },
    {
      researchEnabled: true,
      qwenApiKey: "test-key",
      researchFetch: async () => {
        called = true;
        throw new Error("provider should not be called");
      }
    }
  );
});

test("API research uses Qwen page context and expands citations without returning page text", async () => {
  await withServer(
    async (baseUrl, { dbPath }) => {
      const repo = new PaperRepository(dbPath);
      const draftId = repo.createDraft({ title: "Research API paper", classification: {} });
      const paperId = repo.confirmDraft(draftId);
      repo.replacePaperPages(paperId, [
        { pageNumber: 1, source: "pdf", text: "Loess evidence supports the result.", language: "en" }
      ]);

      const response = await fetch(`${baseUrl}/api/research/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "What supports the result?", paperIds: [paperId] })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.answer, "The result is supported.");
      assert.deepEqual(body.citations, [{ citationId: `P${paperId}-1`, paperId, pageNumber: 1, title: "Research API paper" }]);
      assert.doesNotMatch(JSON.stringify(body), /Loess evidence/);
      assert.doesNotMatch(JSON.stringify(body), /test-key|dashscope|compatible-mode|research-workspace/i);

      const history = await fetch(`${baseUrl}/api/research/answers?limit=1`);
      assert.equal(history.status, 200);
      assert.equal((await history.json())[0].citations[0].title, "Research API paper");
      const db = openDb(dbPath);
      try {
        const columns = db.prepare("PRAGMA table_info(research_answers)").all().map((column) => column.name);
        assert.deepEqual(columns, ["id", "question", "answer", "citations_json", "project_id", "paper_ids_json", "provider", "model", "created_at"]);
        const stored = db.prepare("SELECT * FROM research_answers").get();
        assert.doesNotMatch(JSON.stringify(stored), /test-key|Loess evidence|prompt|context/i);
      } finally {
        db.close();
      }
    },
    {
      researchEnabled: true,
      qwenApiKey: "test-key",
      qwenModel: "qwen-test",
      researchFetch: async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.match(payload.messages[1].content, /Loess evidence supports/);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "The result is supported.", citations: ["P1-1"] }) } }] }), { status: 200 });
      }
    }
  );
});

test("API research maps missing Qwen key, provider timeout, and invalid JSON without leaking details", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({ title: "Key requirement paper", classification: {} });
    const paperId = repo.confirmDraft(draftId);
    repo.replacePaperPages(paperId, [{ pageNumber: 1, source: "pdf", text: "supports result", language: "en" }]);
    const response = await fetch(`${baseUrl}/api/research/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "supports result" })
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /QWEN_API_KEY/);
  }, { researchEnabled: true, qwenApiKey: "" });

  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const draftId = repo.createDraft({ title: "Timeout requirement paper", classification: {} });
    const paperId = repo.confirmDraft(draftId);
    repo.replacePaperPages(paperId, [{ pageNumber: 1, source: "pdf", text: "supports result", language: "en" }]);
    const response = await fetch(`${baseUrl}/api/research/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "supports result" })
    });
    assert.equal(response.status, 502);
    const error = (await response.json()).error;
    assert.match(error, /研究问答服务暂时不可用/);
    assert.doesNotMatch(error, /test-key|https?:|[A-Z]:\\/);
  }, {
    researchEnabled: true,
    qwenApiKey: "test-key",
    researchFetch: async () => { throw new Error("timeout at https://secret.example/key"); }
  });
});

test("API research rejects missing projects and inactive paper restrictions accurately", async () => {
  await withServer(async (baseUrl) => {
    const missingProject = await fetch(`${baseUrl}/api/research/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Question", projectId: 999999 })
    });
    assert.equal(missingProject.status, 404);
    assert.match((await missingProject.json()).error, /Project not found/);
  }, { researchEnabled: true, qwenApiKey: "test-key" });
});

test("API reindex rejects inactive or source-less papers and preserves old pages on extraction failure", async () => {
  await withServer(
    async (baseUrl, { dbPath, filesDir }) => {
      const repo = new PaperRepository(dbPath);
      const createPaper = (input = {}) => repo.confirmDraft(repo.createDraft({ title: "API state paper", classification: {}, ...input }));
      const noSourceId = createPaper();
      const noSourceResponse = await fetch(`${baseUrl}/api/papers/${noSourceId}/reindex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(noSourceResponse.status, 404);

      const trashedId = createPaper({ storedPath: "missing.pdf" });
      repo.replacePaperPages(trashedId, [{ pageNumber: 1, text: "old page", source: "pdf", language: "" }]);
      repo.trashPaper(trashedId);
      const trashedResponse = await fetch(`${baseUrl}/api/papers/${trashedId}/reindex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(trashedResponse.status, 409);

      const mergedId = createPaper({ storedPath: "missing.pdf" });
      const db = openDb(dbPath);
      try {
        db.prepare("UPDATE papers SET deleted_at = CURRENT_TIMESTAMP, merged_into_id = 999 WHERE id = ?").run(mergedId);
      } finally {
        db.close();
      }
      const mergedResponse = await fetch(`${baseUrl}/api/papers/${mergedId}/reindex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(mergedResponse.status, 409);

      await mkdir(path.join(filesDir, "2026"), { recursive: true });
      await writeFile(path.join(filesDir, "2026", "failing.pdf"), "generated test fixture");
      const failedId = createPaper({ storedPath: "2026/failing.pdf" });
      repo.replacePaperPages(failedId, [{ pageNumber: 1, text: "keep this page", source: "pdf", language: "" }]);
      const failedResponse = await fetch(`${baseUrl}/api/papers/${failedId}/reindex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      assert.equal(failedResponse.status, 422);
      assert.match((await failedResponse.json()).error, /extraction failed/i);
      assert.deepEqual(repo.listPaperPages(failedId).map((page) => page.text), ["keep this page"]);
    },
    { extractPdfPages: async () => { throw new Error("private source path leaked"); } }
  );
});

test("confirming a draft indexes a safe source when available but does not roll back confirmation", async () => {
  await withServer(
    async (baseUrl, { dbPath, filesDir }) => {
      await mkdir(path.join(filesDir, "2026"), { recursive: true });
      await writeFile(path.join(filesDir, "2026", "confirm.pdf"), "generated test fixture");
      const repo = new PaperRepository(dbPath);
      const draftId = repo.createDraft({
        storedFilename: "confirm.pdf",
        storedPath: "2026/confirm.pdf",
        title: "Confirm source paper",
        classification: {}
      });
      const response = await fetch(`${baseUrl}/api/drafts/${draftId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.indexState, "failed");
      assert.equal(body.error, "indexing failed");
      assert.equal(repo.getDraft(draftId).status, "confirmed");
      assert.equal(JSON.stringify(body).includes(filesDir), false);
    },
    { extractPdfPages: async () => { throw new Error("private source path"); } }
  );
});

test("project writing API persists drafts, inserts evidence, and filters evidence rows", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const repo = new PaperRepository(dbPath);
    const paperId = repo.confirmDraft(repo.createDraft({
      title: "Writing API paper",
      authors: ["Zhou Changbai"],
      year: 2026,
      journal: "Quaternary Research",
      classification: {}
    }));
    const project = repo.createProject({ name: "Writing API project" });
    repo.addProjectPaper(project.id, paperId, { stance: "supports" });

    const initialResponse = await fetch(`${baseUrl}/api/projects/${project.id}/writing`);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.version, 1);

    const updateResponse = await fetch(`${baseUrl}/api/projects/${project.id}/writing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Chapter", body: "Opening", citationStyle: "gbt7714", citedPaperIds: [], expectedVersion: initial.version })
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json();

    const insertResponse = await fetch(`${baseUrl}/api/projects/${project.id}/writing/evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paperId, quote: "Quoted evidence", pageNumber: 2, expectedVersion: updated.version })
    });
    assert.equal(insertResponse.status, 200);
    const inserted = await insertResponse.json();
    assert.deepEqual(inserted.citedPaperIds, [paperId]);
    assert.match(inserted.bibliography, /Writing API paper/);

    const filtered = await fetch(`${baseUrl}/api/projects/${project.id}/evidence?format=json&stance=opposes`);
    assert.equal(filtered.status, 200);
    assert.deepEqual(await filtered.json(), []);
  });
});
