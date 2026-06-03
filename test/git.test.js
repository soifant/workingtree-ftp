import test from "node:test";
import assert from "node:assert/strict";
import { parseGitStatus } from "../src/git.js";

test("parseGitStatus membaca modified, untracked, dan rename", () => {
  const raw = " M src/app.js\0?? notes.txt\0R  new-name.txt\0old-name.txt\0";
  const result = parseGitStatus(raw);

  assert.deepEqual(result, [
    { code: " M", path: "src/app.js" },
    { code: "??", path: "notes.txt" },
    { code: "R ", path: "new-name.txt", originalPath: "old-name.txt" }
  ]);
});
