import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function formatGitError(args, error) {
  const detail = error.stderr?.trim() || error.message;
  return `Gagal menjalankan git ${args.join(" ")}: ${detail}`;
}

async function execGit(args, cwd) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
}

export async function runGitCommand(args, cwd) {
  try {
    const { stdout } = await execGit(args, cwd);
    return stdout;
  } catch (error) {
    throw new Error(formatGitError(args, error));
  }
}

export async function tryRunGitCommand(args, cwd) {
  try {
    const { stdout, stderr } = await execGit(args, cwd);
    return {
      ok: true,
      stdout,
      stderr,
      code: 0
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      code: typeof error.code === "number" ? error.code : null,
      error: new Error(formatGitError(args, error))
    };
  }
}

export async function findGitRoot(startDir) {
  const stdout = await runGitCommand(["rev-parse", "--show-toplevel"], startDir);
  return stdout.trim();
}

export async function getGitDir(startDir) {
  const stdout = await runGitCommand(["rev-parse", "--absolute-git-dir"], startDir);
  return stdout.trim();
}

export async function readHeadCommit(repoRoot) {
  const result = await tryRunGitCommand(["rev-parse", "--verify", "HEAD"], repoRoot);
  if (!result.ok) {
    return null;
  }

  return result.stdout.trim();
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
  const stdout = await runGitCommand(["status", "--porcelain=1", "-z", "-uall"], repoRoot);
  return parseGitStatus(stdout);
}
