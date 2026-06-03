import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import {
  buildSingleDeletePlan,
  buildSingleDownloadTarget,
  buildSingleUploadPlan
} from "../src/single-target.js";

test("buildSingleUploadPlan membuat plan upload tunggal untuk file di dalam repo", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-single-"));

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await mkdir(path.join(repoRoot, "nested"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "app.js"), "console.log('x');\n", "utf8");

    const plan = await buildSingleUploadPlan(repoRoot, "..\\src\\app.js", path.join(repoRoot, "nested"));

    assert.deepEqual(plan, {
      uploads: [
        {
          relativePath: "src/app.js",
          absolutePath: path.join(repoRoot, "src", "app.js"),
          reason: "manual"
        }
      ],
      deletions: [],
      skipped: [],
      conflicts: []
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildSingleUploadPlan menolak path di luar repo", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-single-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-outside-"));

  try {
    await writeFile(path.join(outsideRoot, "app.js"), "console.log('x');\n", "utf8");

    await assert.rejects(
      () => buildSingleUploadPlan(repoRoot, path.join(outsideRoot, "app.js")),
      (error) => {
        assert.match(error.message, /Path berada di luar repository Git/);
        return true;
      }
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("buildSingleDeletePlan membuat delete tunggal tanpa perlu file lokal ada", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-single-"));

  try {
    const plan = buildSingleDeletePlan(repoRoot, "removed/old.txt", repoRoot);

    assert.deepEqual(plan, {
      uploads: [],
      deletions: [
        {
          relativePath: "removed/old.txt",
          reason: "manual"
        }
      ],
      skipped: [],
      conflicts: []
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildSingleDownloadTarget menghasilkan target lokal dalam repo", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-single-"));

  try {
    await mkdir(path.join(repoRoot, "nested"), { recursive: true });

    const target = buildSingleDownloadTarget(repoRoot, "..\\assets\\logo.png", path.join(repoRoot, "nested"));

    assert.deepEqual(target, {
      absolutePath: path.join(repoRoot, "assets", "logo.png"),
      relativePath: "assets/logo.png"
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
