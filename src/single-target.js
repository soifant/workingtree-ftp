import path from "node:path";
import { lstat } from "node:fs/promises";

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

export function resolveRepoRelativeTarget(repoRoot, inputPath, cwd = process.cwd()) {
  const absolutePath = path.resolve(cwd, inputPath);
  const relativePath = path.relative(repoRoot, absolutePath);

  if (!relativePath || relativePath === "." || relativePath === "") {
    throw new Error("Path harus menunjuk file di dalam repository, bukan root repository.");
  }

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path berada di luar repository Git: ${absolutePath}`);
  }

  return {
    absolutePath,
    relativePath: toPosixPath(relativePath)
  };
}

export async function buildSingleUploadPlan(repoRoot, inputPath, cwd = process.cwd()) {
  const target = resolveRepoRelativeTarget(repoRoot, inputPath, cwd);

  let fileStat;
  try {
    fileStat = await lstat(target.absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`File upload tidak ditemukan: ${target.absolutePath}`);
    }
    throw error;
  }

  if (!fileStat.isFile()) {
    throw new Error(`Path upload bukan file reguler: ${target.absolutePath}`);
  }

  return {
    uploads: [
      {
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        reason: "manual"
      }
    ],
    deletions: [],
    skipped: [],
      conflicts: []
  };
}

export function buildSingleDeletePlan(repoRoot, inputPath, cwd = process.cwd()) {
  const target = resolveRepoRelativeTarget(repoRoot, inputPath, cwd);

  return {
    uploads: [],
    deletions: [
      {
        relativePath: target.relativePath,
        reason: "manual"
      }
    ],
    skipped: [],
    conflicts: []
  };
}

export function buildSingleDownloadTarget(repoRoot, inputPath, cwd = process.cwd()) {
  return resolveRepoRelativeTarget(repoRoot, inputPath, cwd);
}
