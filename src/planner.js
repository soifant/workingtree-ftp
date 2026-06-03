import path from "node:path";
import { lstat } from "node:fs/promises";

const DEFAULT_EXCLUDED_PATHS = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".workingtree-ftp.json",
  ".uncommit-ftp.json"
]);

function toSystemPath(relativePath) {
  return relativePath.split("/").join(path.sep);
}

function reasonForEntry(entry) {
  if (entry.code === "??") {
    return "untracked";
  }

  if (entry.code.includes("R")) {
    return "renamed";
  }

  if (entry.code.includes("C")) {
    return "copied";
  }

  if (entry.code.includes("D")) {
    return "deleted";
  }

  if (entry.code.includes("A")) {
    return "added";
  }

  if (entry.code.includes("T")) {
    return "type-changed";
  }

  return "modified";
}

function isConflictCode(code) {
  return code.includes("U") || code === "AA" || code === "DD";
}

function shouldUploadEntry(entry, includeUntracked) {
  if (entry.code === "??") {
    return includeUntracked;
  }

  if (entry.code.includes("D")) {
    return false;
  }

  return true;
}

function shouldDeleteEntry(entry, deleteRemoved) {
  if (!deleteRemoved) {
    return false;
  }

  return entry.code.includes("D") || entry.code.includes("R");
}

async function resolveUploadableFile(repoRoot, relativePath, reason) {
  const absolutePath = path.join(repoRoot, toSystemPath(relativePath));

  try {
    const fileStat = await lstat(absolutePath);
    if (!fileStat.isFile()) {
      return {
        kind: "skipped",
        relativePath,
        reason: `${reason}; bukan file reguler`
      };
    }

    return {
      kind: "upload",
      relativePath,
      absolutePath,
      reason
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        kind: "skipped",
        relativePath,
        reason: `${reason}; file tidak ditemukan`
      };
    }

    throw error;
  }
}

export async function buildTransferPlan(repoRoot, changes, options = {}) {
  const includeUntracked = options.includeUntracked ?? true;
  const deleteRemoved = options.deleteRemoved ?? false;
  const excludePaths = new Set([...(options.excludePaths || []), ...DEFAULT_EXCLUDED_PATHS]);
  const uploads = [];
  const deletions = [];
  const skipped = [];
  const conflicts = [];
  const seenUploads = new Set();
  const seenDeletions = new Set();

  for (const entry of changes) {
    const reason = reasonForEntry(entry);
    const uploadPathExcluded = excludePaths.has(entry.path);
    const deletePath = entry.code.includes("R") ? entry.originalPath : entry.path;
    const deletePathExcluded = Boolean(deletePath && excludePaths.has(deletePath));

    if (isConflictCode(entry.code)) {
      conflicts.push({
        relativePath: entry.path,
        code: entry.code
      });
      continue;
    }

    if (uploadPathExcluded) {
      skipped.push({
        relativePath: entry.path,
        reason: "dikecualikan"
      });
    }

    if (entry.originalPath && deletePathExcluded && entry.originalPath !== entry.path) {
      skipped.push({
        relativePath: entry.originalPath,
        reason: "dikecualikan"
      });
    }

    if (!uploadPathExcluded && shouldUploadEntry(entry, includeUntracked) && !seenUploads.has(entry.path)) {
      const candidate = await resolveUploadableFile(repoRoot, entry.path, reason);
      if (candidate.kind === "upload") {
        uploads.push(candidate);
        seenUploads.add(entry.path);
      } else {
        skipped.push(candidate);
      }
    } else if (entry.code === "??" && !includeUntracked) {
      skipped.push({
        relativePath: entry.path,
        reason: "untracked; dikecualikan oleh opsi"
      });
    }

    if (shouldDeleteEntry(entry, deleteRemoved) && !deletePathExcluded) {
      if (!seenDeletions.has(deletePath)) {
        deletions.push({
          relativePath: deletePath,
          reason
        });
        seenDeletions.add(deletePath);
      }
    } else if (entry.code.includes("D")) {
      skipped.push({
        relativePath: entry.path,
        reason: "deleted; gunakan --delete-removed untuk hapus remote"
      });
    } else if (entry.code.includes("R") && !deleteRemoved && entry.originalPath) {
      skipped.push({
        relativePath: entry.originalPath,
        reason: "renamed; gunakan --delete-removed untuk hapus path lama di remote"
      });
    }
  }

  return {
    uploads,
    deletions,
    skipped,
    conflicts
  };
}
