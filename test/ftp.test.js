import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { downloadAllFiles, downloadSingleFile, executeTransferPlan } from "../src/ftp.js";

function withCapturedStdout(run) {
  const originalWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk, ...args) => {
    chunks.push(String(chunk));
    if (typeof args[args.length - 1] === "function") {
      args[args.length - 1]();
    }
    return true;
  };

  return Promise.resolve()
    .then(() => run(chunks))
    .finally(() => {
      process.stdout.write = originalWrite;
    });
}

test("executeTransferPlan retries upload after deleting same remote file when enabled", async () => {
  await withCapturedStdout(async (chunks) => {
    const calls = [];
    let uploadAttempts = 0;
    const uploadError = new Error("553 Could not create file because file already exists");
    uploadError.code = 553;
    const client = {
      ensureDir: async (remoteDir) => {
        calls.push(["ensureDir", remoteDir]);
      },
      uploadFrom: async (absolutePath, remotePath) => {
        calls.push(["uploadFrom", absolutePath, remotePath]);
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          throw uploadError;
        }
      },
      remove: async (remotePath) => {
        calls.push(["remove", remotePath]);
      },
      close: () => {
        calls.push(["close"]);
      }
    };

    await executeTransferPlan(
      {
        uploads: [
          {
            relativePath: "dist/app.js",
            absolutePath: "C:\\repo\\dist\\app.js",
            reason: "modified"
          }
        ],
        deletions: [],
        skipped: [],
        conflicts: []
      },
      { remoteRoot: "/public_html" },
      {},
      {
        deleteSameFile: true,
        clientFactory: async () => client
      }
    );

    assert.deepEqual(calls, [
      ["ensureDir", "/public_html/dist"],
      ["uploadFrom", "C:\\repo\\dist\\app.js", "/public_html/dist/app.js"],
      ["remove", "/public_html/dist/app.js"],
      ["uploadFrom", "C:\\repo\\dist\\app.js", "/public_html/dist/app.js"],
      ["close"]
    ]);
    assert.match(
      chunks.join(""),
      /replace dist\/app\.js -> \/public_html\/dist\/app\.js \(hapus file remote lalu retry upload\)/
    );
  });
});

test("executeTransferPlan does not delete remote file for unrelated upload errors", async () => {
  await withCapturedStdout(async () => {
    const calls = [];
    const uploadError = new Error("ECONNRESET");
    const client = {
      ensureDir: async (remoteDir) => {
        calls.push(["ensureDir", remoteDir]);
      },
      uploadFrom: async (absolutePath, remotePath) => {
        calls.push(["uploadFrom", absolutePath, remotePath]);
        throw uploadError;
      },
      remove: async (remotePath) => {
        calls.push(["remove", remotePath]);
      },
      close: () => {
        calls.push(["close"]);
      }
    };

    await assert.rejects(
      () =>
        executeTransferPlan(
          {
            uploads: [
              {
                relativePath: "dist/app.js",
                absolutePath: "C:\\repo\\dist\\app.js",
                reason: "modified"
              }
            ],
            deletions: [],
            skipped: [],
            conflicts: []
          },
          { remoteRoot: "/public_html" },
          {},
          {
            deleteSameFile: true,
            clientFactory: async () => client
          }
        ),
      (error) => {
        assert.match(error.message, /FTP upload gagal: dist\/app\.js -> \/public_html\/dist\/app\.js: ECONNRESET/);
        return true;
      }
    );

    assert.deepEqual(calls, [
      ["ensureDir", "/public_html/dist"],
      ["uploadFrom", "C:\\repo\\dist\\app.js", "/public_html/dist/app.js"],
      ["close"]
    ]);
  });
});

test("downloadSingleFile mendownload satu file ke path lokal yang sesuai", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-download-"));

  try {
    await withCapturedStdout(async (chunks) => {
      const calls = [];
      const target = {
        relativePath: "assets/logo.png",
        absolutePath: path.join(repoRoot, "assets", "logo.png")
      };
      const client = {
        downloadTo: async (destination, remotePath) => {
          calls.push(["downloadTo", destination, remotePath]);
        },
        close: () => {
          calls.push(["close"]);
        }
      };

      await downloadSingleFile(
        target,
        { remoteRoot: "/public_html" },
        {},
        {
          clientFactory: async () => client
        }
      );

      assert.deepEqual(calls, [
        ["downloadTo", path.join(repoRoot, "assets", "logo.png"), "/public_html/assets/logo.png"],
        ["close"]
      ]);
      assert.match(chunks.join(""), /download assets\/logo\.png <- \/public_html\/assets\/logo\.png/);
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("downloadAllFiles mendownload seluruh remote root ke repo lokal", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "wftp-download-all-"));

  try {
    await withCapturedStdout(async (chunks) => {
      const calls = [];
      const client = {
        downloadToDir: async (localDir, remoteDir) => {
          calls.push(["downloadToDir", localDir, remoteDir]);
        },
        close: () => {
          calls.push(["close"]);
        }
      };

      await downloadAllFiles(
        repoRoot,
        { remoteRoot: "/public_html/site" },
        {},
        {
          clientFactory: async () => client
        }
      );

      assert.deepEqual(calls, [
        ["downloadToDir", repoRoot, "/public_html/site"],
        ["close"]
      ]);
      assert.ok(chunks.join("").includes(`download-all ${repoRoot} <- /public_html/site`));
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
