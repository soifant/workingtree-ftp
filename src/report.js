import path from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  getGitDir,
  readHeadCommit,
  readWorkingTreeChanges,
  runGitCommand,
  tryRunGitCommand
} from "./git.js";

const REPORT_STATE_FILE = "workingtree-ftp-report.json";

function stripDiffPrefix(filePath) {
  if (filePath === "/dev/null") {
    return filePath;
  }

  if (filePath.startsWith("a/") || filePath.startsWith("b/")) {
    return filePath.slice(2);
  }

  return filePath;
}

function expandLineRange(start, count) {
  const total = count === undefined ? 1 : Number(count);
  if (total <= 0) {
    return [];
  }

  return Array.from({ length: total }, (_, index) => Number(start) + index);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function finalizePatchEntry(current) {
  if (!current || !current.oldPath || !current.newPath) {
    return null;
  }

  if (current.oldPath === "/dev/null") {
    return {
      action: "ADD",
      relativePath: stripDiffPrefix(current.newPath),
      lineNumbers: []
    };
  }

  if (current.newPath === "/dev/null") {
    return {
      action: "DEL",
      relativePath: stripDiffPrefix(current.oldPath),
      lineNumbers: uniqueSorted(current.oldLines)
    };
  }

  return {
    action: "EDIT",
    relativePath: stripDiffPrefix(current.newPath),
    lineNumbers: uniqueSorted(current.newLines.length > 0 ? current.newLines : current.oldLines)
  };
}

export function parseUnifiedDiffPatch(raw) {
  const entries = [];
  const lines = raw.split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const finalized = finalizePatchEntry(current);
      if (finalized) {
        entries.push(finalized);
      }

      current = {
        oldPath: null,
        newPath: null,
        oldLines: [],
        newLines: []
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("--- ")) {
      current.oldPath = line.slice(4).trim();
      continue;
    }

    if (line.startsWith("+++ ")) {
      current.newPath = line.slice(4).trim();
      continue;
    }

    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) {
      continue;
    }

    const [, oldStart, oldCount, newStart, newCount] = match;
    current.oldLines.push(...expandLineRange(oldStart, oldCount));
    current.newLines.push(...expandLineRange(newStart, newCount));
  }

  const finalized = finalizePatchEntry(current);
  if (finalized) {
    entries.push(finalized);
  }

  return entries;
}

function mapStatusEntryToAction(entry) {
  if (entry.code === "??" || entry.code.includes("A") || entry.code.includes("C")) {
    return "ADD";
  }

  if (entry.code.includes("D")) {
    return "DEL";
  }

  return "EDIT";
}

function buildDiffEntryMap(entries) {
  return new Map(entries.map((entry) => [entry.relativePath, entry]));
}

function buildUncommittedEntries(statusEntries, diffEntries) {
  const diffByPath = buildDiffEntryMap(diffEntries);
  const entries = [];
  const seen = new Set();

  function pushEntry(action, relativePath) {
    const key = `${action}:${relativePath}`;
    if (seen.has(key)) {
      return;
    }

    const diffEntry = diffByPath.get(relativePath);
    entries.push({
      action,
      relativePath,
      lineNumbers:
        action === "ADD"
          ? []
          : uniqueSorted(diffEntry?.lineNumbers || [])
    });
    seen.add(key);
  }

  for (const entry of statusEntries) {
    if (entry.code.includes("R") && entry.originalPath) {
      pushEntry("DEL", entry.originalPath);
      pushEntry("ADD", entry.path);
      continue;
    }

    pushEntry(mapStatusEntryToAction(entry), entry.path);
  }

  return entries;
}

function formatLines(lineNumbers) {
  if (lineNumbers.length === 0) {
    return null;
  }

  return `LINE ${lineNumbers.join(",")}`;
}

export function formatReportContent(sections, options = {}) {
  const includeLines = options.includeLines ?? false;
  const chunks = [];

  for (const section of sections) {
    chunks.push(`# ${section.title}`);
    chunks.push("");

    if (section.entries.length === 0) {
      chunks.push("Tidak ada perubahan.");
      chunks.push("");
      continue;
    }

    for (const entry of section.entries) {
      chunks.push(`[${entry.action}] ${entry.relativePath}`);

      if (includeLines && entry.action !== "ADD") {
        const lineText = formatLines(entry.lineNumbers || []);
        if (lineText) {
          chunks.push(lineText);
        }
      }

      chunks.push("");
    }
  }

  return `${chunks.join("\n").trimEnd()}\n`;
}

function formatDateYYYYMMDD(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function sanitizeReportBaseName(name) {
  const sanitized = name.replace(/[\\/:*?"<>|]/g, "_").trim().replace(/\.txt$/i, "");
  return sanitized || "report";
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function resolveReportFilePath(repoRoot, options = {}, now = new Date()) {
  if (options.nameDate && !options.name) {
    throw new Error('Opsi "--name-date" membutuhkan "--name".');
  }

  const repoName = sanitizeReportBaseName(path.basename(repoRoot) || "report");
  const datePart = formatDateYYYYMMDD(now);

  let baseName;
  if (options.name) {
    const customName = sanitizeReportBaseName(options.name);
    baseName = options.nameDate ? `${customName}_${datePart}` : customName;
  } else {
    baseName = `${repoName}_${datePart}`;
  }

  let candidate = path.join(repoRoot, `${baseName}.txt`);
  let suffix = 2;

  while (await fileExists(candidate)) {
    candidate = path.join(repoRoot, `${baseName}_${suffix}.txt`);
    suffix += 1;
  }

  return candidate;
}

function getReportStatePath(gitDir) {
  return path.join(gitDir, REPORT_STATE_FILE);
}

async function readReportState(gitDir) {
  try {
    const raw = await readFile(getReportStatePath(gitDir), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function writeReportState(gitDir, state) {
  await writeFile(getReportStatePath(gitDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readCommitSubject(repoRoot, commitId) {
  const stdout = await runGitCommand(["show", "-s", "--format=%s", commitId], repoRoot);
  return stdout.trim() || commitId;
}

async function readCommitPatch(repoRoot, commitId) {
  return runGitCommand(
    ["show", "--format=", "--unified=0", "--no-color", "--no-renames", "--no-ext-diff", commitId],
    repoRoot
  );
}

async function listAllCommitIds(repoRoot) {
  const headCommit = await readHeadCommit(repoRoot);
  if (!headCommit) {
    return [];
  }

  const stdout = await runGitCommand(["rev-list", "--reverse", "HEAD"], repoRoot);
  return stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function listCommitIdsAfter(repoRoot, commitId) {
  const headCommit = await readHeadCommit(repoRoot);
  if (!headCommit) {
    return [];
  }

  const stdout = await runGitCommand(["rev-list", "--reverse", `${commitId}..HEAD`], repoRoot);
  return stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function validateCommit(repoRoot, commitId, optionName) {
  const result = await tryRunGitCommand(["rev-parse", "--verify", commitId], repoRoot);
  if (!result.ok) {
    throw new Error(`Commit untuk ${optionName} tidak valid: ${commitId}`);
  }
}

async function listCommitIdsInRange(repoRoot, startCommit, endCommit) {
  await validateCommit(repoRoot, startCommit, "--start");
  await validateCommit(repoRoot, endCommit, "--end");

  if (startCommit === endCommit) {
    return [startCommit];
  }

  const ancestorCheck = await tryRunGitCommand(["merge-base", "--is-ancestor", startCommit, endCommit], repoRoot);
  if (!ancestorCheck.ok) {
    if (ancestorCheck.code === 1) {
      throw new Error(`Commit start ${startCommit} bukan ancestor dari commit end ${endCommit}.`);
    }

    throw ancestorCheck.error;
  }

  const stdout = await runGitCommand(
    ["rev-list", "--reverse", "--ancestry-path", `${startCommit}..${endCommit}`],
    repoRoot
  );
  const tail = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  return [startCommit, ...tail];
}

async function buildCommitSections(repoRoot, commitIds) {
  const sections = [];

  for (const commitId of commitIds) {
    const [title, patch] = await Promise.all([
      readCommitSubject(repoRoot, commitId),
      readCommitPatch(repoRoot, commitId)
    ]);
    const entries = parseUnifiedDiffPatch(patch);
    if (entries.length === 0) {
      continue;
    }

    sections.push({
      title,
      commitId,
      entries
    });
  }

  return sections;
}

async function buildUncommittedSections(repoRoot) {
  const statusEntries = await readWorkingTreeChanges(repoRoot);
  const headCommit = await readHeadCommit(repoRoot);
  const patch = headCommit
    ? await runGitCommand(
        ["diff", "HEAD", "--unified=0", "--no-color", "--no-renames", "--no-ext-diff"],
        repoRoot
      )
    : "";
  const entries = buildUncommittedEntries(statusEntries, parseUnifiedDiffPatch(patch));

  return [
    {
      title: "UNCOMMITTED CHANGES",
      entries
    }
  ];
}

async function buildAutomaticCommittedSections(repoRoot, gitDir) {
  const headCommit = await readHeadCommit(repoRoot);
  if (!headCommit) {
    throw new Error("Belum ada commit di repository ini.");
  }

  const state = await readReportState(gitDir);
  let commitIds;

  if (!state?.lastCommit) {
    commitIds = await listAllCommitIds(repoRoot);
    return {
      commitIds,
      latestCommit: headCommit,
      sections: await buildCommitSections(repoRoot, commitIds)
    };
  }

  const lastCommitCheck = await tryRunGitCommand(["rev-parse", "--verify", state.lastCommit], repoRoot);
  if (!lastCommitCheck.ok) {
    commitIds = await listAllCommitIds(repoRoot);
    return {
      commitIds,
      latestCommit: headCommit,
      sections: await buildCommitSections(repoRoot, commitIds)
    };
  }

  commitIds = await listCommitIdsAfter(repoRoot, state.lastCommit);
  if (commitIds.length === 0) {
    return {
      commitIds,
      latestCommit: headCommit,
      sections: [],
      previousCommit: state.lastCommit
    };
  }

  return {
    commitIds,
    latestCommit: headCommit,
    previousCommit: state.lastCommit,
    sections: await buildCommitSections(repoRoot, commitIds)
  };
}

function validateReportOptions(options) {
  const hasRangeStart = Boolean(options.start);
  const hasRangeEnd = Boolean(options.end);

  if (options.uncommit && (hasRangeStart || hasRangeEnd)) {
    throw new Error('Opsi "--uncommit" tidak bisa dipakai bersamaan dengan range commit.');
  }

  if (hasRangeStart !== hasRangeEnd) {
    throw new Error('Gunakan "--start" dan "--end" bersamaan.');
  }
}

export async function createReport(repoRoot, options = {}) {
  validateReportOptions(options);

  const gitDir = options.gitDir || (await getGitDir(repoRoot));
  let sections;
  let latestCommit = null;
  let reportMode = "uncommit";
  let noChangesMessage = null;

  if (options.uncommit) {
    sections = await buildUncommittedSections(repoRoot);
  } else if (options.start && options.end) {
    const commitIds = await listCommitIdsInRange(repoRoot, options.start, options.end);
    if (commitIds.length === 0) {
      throw new Error("Tidak ada commit dalam range yang diminta.");
    }

    sections = await buildCommitSections(repoRoot, commitIds);
    latestCommit = commitIds[commitIds.length - 1];
    reportMode = "range";
  } else {
    const automatic = await buildAutomaticCommittedSections(repoRoot, gitDir);
    sections = automatic.sections;
    latestCommit = automatic.latestCommit;
    reportMode = "auto";

    if (automatic.commitIds.length === 0) {
      noChangesMessage = automatic.previousCommit
        ? `Tidak ada commit baru sejak ${automatic.previousCommit}.`
        : "Tidak ada commit untuk dibuat report.";
    }
  }

  if (reportMode === "auto" && noChangesMessage) {
    return {
      kind: "noop",
      message: noChangesMessage
    };
  }

  const filePath = await resolveReportFilePath(repoRoot, options, options.now);
  const content = formatReportContent(sections, {
    includeLines: Boolean(options.line)
  });
  await writeFile(filePath, content, "utf8");

  if (reportMode === "auto" && latestCommit) {
    await writeReportState(gitDir, {
      lastCommit: latestCommit,
      updatedAt: new Date().toISOString(),
      lastReportPath: filePath
    });
  }

  return {
    kind: "written",
    filePath,
    mode: reportMode,
    sectionCount: sections.length
  };
}
