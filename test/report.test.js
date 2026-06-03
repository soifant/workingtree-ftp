import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createReport, formatReportContent, parseUnifiedDiffPatch, resolveReportFilePath } from "../src/report.js";

const execFileAsync = promisify(execFile);

async function runGit(args, cwd) {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8"
  });
}

test("parseUnifiedDiffPatch membaca add, edit, dan delete beserta line number", () => {
  const raw = [
    "diff --git a/src/app.js b/src/app.js",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -10,2 +10,3 @@",
    "diff --git a/old.txt b/old.txt",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,4 @@"
  ].join("\n");

  assert.deepEqual(parseUnifiedDiffPatch(raw), [
    {
      action: "EDIT",
      relativePath: "src/app.js",
      lineNumbers: [10, 11, 12]
    },
    {
      action: "DEL",
      relativePath: "old.txt",
      lineNumbers: [1, 2, 3]
    },
    {
      action: "ADD",
      relativePath: "new.txt",
      lineNumbers: []
    }
  ]);
});

test("formatReportContent mengikuti format section dan entry yang diharapkan", () => {
  const content = formatReportContent(
    [
      {
        title: "COMMIT MESSAGE 1",
        entries: [
          {
            action: "EDIT",
            relativePath: "src/app.js",
            lineNumbers: [1, 2, 3]
          },
          {
            action: "DEL",
            relativePath: "old.txt",
            lineNumbers: [4, 5]
          },
          {
            action: "ADD",
            relativePath: "new.txt",
            lineNumbers: []
          }
        ]
      }
    ],
    {
      includeLines: true
    }
  );

  assert.equal(
    content,
    [
      "# COMMIT MESSAGE 1",
      "",
      "[EDIT] src/app.js",
      "LINE 1,2,3",
      "",
      "[DEL] old.txt",
      "LINE 4,5",
      "",
      "[ADD] new.txt",
      ""
    ].join("\n")
  );
});

test("resolveReportFilePath memakai nama folder dan menambah suffix jika file sudah ada", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-report-name-"));

  try {
    const now = new Date(2026, 5, 3, 12, 0, 0);
    const first = await resolveReportFilePath(repoRoot, {}, now);
    await writeFile(first, "x\n", "utf8");
    const second = await resolveReportFilePath(repoRoot, {}, now);

    assert.match(path.basename(first), /^wftp-report-name-.*_20260603\.txt$/);
    assert.match(path.basename(second), /^wftp-report-name-.*_20260603_2\.txt$/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("createReport default menyimpan semua commit saat pertama kali lalu hanya commit baru setelahnya", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-report-flow-"));
  const now = new Date(2026, 5, 3, 12, 0, 0);

  try {
    await runGit(["init"], repoRoot);
    await runGit(["config", "user.name", "Tester"], repoRoot);
    await runGit(["config", "user.email", "tester@example.com"], repoRoot);

    await writeFile(path.join(repoRoot, "app.txt"), "one\n", "utf8");
    await runGit(["add", "app.txt"], repoRoot);
    await runGit(["commit", "-m", "First commit"], repoRoot);

    await writeFile(path.join(repoRoot, "app.txt"), "one\ntwo\n", "utf8");
    await runGit(["add", "app.txt"], repoRoot);
    await runGit(["commit", "-m", "Second commit"], repoRoot);

    const firstReport = await createReport(repoRoot, { now });
    assert.equal(firstReport.kind, "written");

    const firstContent = await readFile(firstReport.filePath, "utf8");
    assert.match(firstContent, /# First commit/);
    assert.match(firstContent, /# Second commit/);

    const secondNoop = await createReport(repoRoot, { now });
    assert.equal(secondNoop.kind, "noop");

    await writeFile(path.join(repoRoot, "new.txt"), "new\n", "utf8");
    await runGit(["add", "new.txt"], repoRoot);
    await runGit(["commit", "-m", "Third commit"], repoRoot);

    const thirdReport = await createReport(repoRoot, { now });
    assert.equal(thirdReport.kind, "written");

    const thirdContent = await readFile(thirdReport.filePath, "utf8");
    assert.doesNotMatch(thirdContent, /# First commit/);
    assert.doesNotMatch(thirdContent, /# Second commit/);
    assert.match(thirdContent, /# Third commit/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
