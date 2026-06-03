import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { buildTransferPlan } from "../src/planner.js";

test("buildTransferPlan menghasilkan upload dan delete yang sesuai", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-plan-"));

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "app.js"), "console.log('x');\n", "utf8");
    await writeFile(path.join(repoRoot, "new.txt"), "new\n", "utf8");
    await writeFile(path.join(repoRoot, "renamed.txt"), "renamed\n", "utf8");

    const plan = await buildTransferPlan(
      repoRoot,
      [
        { code: " M", path: "src/app.js" },
        { code: "??", path: "new.txt" },
        { code: "??", path: ".gitignore" },
        { code: " D", path: "old.txt" },
        { code: "R ", path: "renamed.txt", originalPath: "before.txt" }
      ],
      {
        includeUntracked: true,
        deleteRemoved: true
      }
    );

    assert.equal(plan.uploads.length, 3);
    assert.deepEqual(
      plan.uploads.map((item) => item.relativePath),
      ["src/app.js", "new.txt", "renamed.txt"]
    );
    assert.deepEqual(
      plan.deletions.map((item) => item.relativePath),
      ["old.txt", "before.txt"]
    );
    assert.deepEqual(
      plan.skipped.map((item) => item.relativePath),
      [".gitignore"]
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
