import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Gagal menjalankan git ${args.join(" ")}: ${detail}`);
  }
}

export async function findGitRoot(startDir) {
  const stdout = await runGit(["rev-parse", "--show-toplevel"], startDir);
  return stdout.trim();
}

export function parseGitStatus(raw) {
  const entries = [];
  const parts = raw.split("\0");

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) {
      continue;
    }

    const code = record.slice(0, 2);
    const relativePath = record.slice(3);
    const isRenameOrCopy = code.includes("R") || code.includes("C");

    if (isRenameOrCopy) {
      const originalPath = parts[index + 1];
      if (!originalPath) {
        throw new Error(`Entry rename/copy tidak valid untuk path ${relativePath}.`);
      }

      entries.push({
        code,
        path: relativePath,
        originalPath
      });
      index += 1;
      continue;
    }

    entries.push({
      code,
      path: relativePath
    });
  }

  return entries;
}

export async function readWorkingTreeChanges(repoRoot) {
  const stdout = await runGit(["status", "--porcelain=1", "-z", "-uall"], repoRoot);
  return parseGitStatus(stdout);
}
