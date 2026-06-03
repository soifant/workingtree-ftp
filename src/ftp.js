import path from "node:path";
import { mkdir } from "node:fs/promises";
import ftp from "basic-ftp";

const SAME_FILE_RETRYABLE_CODES = new Set([450, 451, 452, 550, 553]);

function normalizeRemoteRoot(remoteRoot) {
  const compact = remoteRoot.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (compact === "/") {
    return "/";
  }

  const withoutTrailing = compact.endsWith("/") ? compact.slice(0, -1) : compact;
  return withoutTrailing.startsWith("/") ? withoutTrailing : `/${withoutTrailing}`;
}

export function joinRemotePath(remoteRoot, relativePath) {
  const base = normalizeRemoteRoot(remoteRoot);
  const relative = relativePath.replace(/\\/g, "/");
  return path.posix.join(base, relative);
}

function describeError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return `${error}`;
}

export function createTransferError(operation, relativePath, remotePath, error) {
  return new Error(
    `FTP ${operation} gagal: ${relativePath} -> ${remotePath}: ${describeError(error)}`,
    error instanceof Error ? { cause: error } : undefined
  );
}

function createRetryUploadError(relativePath, remotePath, initialError, followupError, phase) {
  const phaseLabel =
    phase === "delete"
      ? "hapus file remote sebelum retry"
      : "upload ulang setelah hapus file remote";
  return new Error(
    `FTP replace gagal: ${relativePath} -> ${remotePath}: upload awal gagal (${describeError(initialError)}); ${phaseLabel} gagal (${describeError(followupError)})`,
    followupError instanceof Error ? { cause: followupError } : undefined
  );
}

function resolvePassword(profile) {
  if (profile.password) {
    return profile.password;
  }

  if (profile.passwordEnv) {
    const value = process.env[profile.passwordEnv];
    if (!value) {
      throw new Error(`Environment variable ${profile.passwordEnv} tidak ditemukan.`);
    }
    return value;
  }

  throw new Error("Profile FTP tidak memiliki password atau passwordEnv.");
}

function isMissingRemoteError(error) {
  const message = `${error?.message || ""}`.toLowerCase();
  return (
    message.includes("550") ||
    message.includes("no such file") ||
    message.includes("not found") ||
    message.includes("file unavailable")
  );
}

function includesAny(message, patterns) {
  return patterns.some((pattern) => message.includes(pattern));
}

export function isSameFileRewriteError(error) {
  const message = `${error?.message || ""}`.toLowerCase();
  const numericCode = Number(error?.code);
  const hasRetryableCode =
    SAME_FILE_RETRYABLE_CODES.has(numericCode) ||
    Array.from(SAME_FILE_RETRYABLE_CODES).some((code) => message.includes(`${code}`));
  const hasExplicitOverwriteHint = includesAny(message, [
    "file exists",
    "already exists",
    "overwrite",
    "cannot overwrite",
    "can't overwrite",
    "cant overwrite"
  ]);
  const hasCreateConflictHint = includesAny(message, [
    "could not create file",
    "cannot create file",
    "can't create file",
    "cant create file",
    "unable to create file"
  ]);

  if (hasExplicitOverwriteHint) {
    return true;
  }

  return hasRetryableCode && hasCreateConflictHint;
}

async function createClient(profile, verbose) {
  const client = new ftp.Client(30_000);
  client.ftp.verbose = false;

  if (verbose) {
    client.trackProgress((info) => {
      if (info.type === "upload") {
        process.stdout.write(`uploaded ${info.name} (${info.bytesOverall} bytes)\n`);
      } else if (info.type === "download") {
        process.stdout.write(`downloaded ${info.name} (${info.bytesOverall} bytes)\n`);
      }
    });
  }

  await client.access({
    host: profile.host,
    port: Number(profile.port || 21),
    user: profile.user,
    password: resolvePassword(profile),
    secure: Boolean(profile.secure)
  });

  return client;
}

async function uploadWithReplaceRetry(client, upload, remotePath, options) {
  try {
    await client.uploadFrom(upload.absolutePath, remotePath);
    return;
  } catch (error) {
    if (!options.deleteSameFile || !isSameFileRewriteError(error)) {
      throw createTransferError("upload", upload.relativePath, remotePath, error);
    }

    process.stdout.write(
      `replace ${upload.relativePath} -> ${remotePath} (hapus file remote lalu retry upload)\n`
    );

    try {
      await client.remove(remotePath);
    } catch (removeError) {
      throw createRetryUploadError(upload.relativePath, remotePath, error, removeError, "delete");
    }

    try {
      await client.uploadFrom(upload.absolutePath, remotePath);
    } catch (retryError) {
      throw createRetryUploadError(upload.relativePath, remotePath, error, retryError, "retry");
    }
  }
}

export async function downloadSingleFile(target, localConfig, profile, options = {}) {
  const verbose = options.verbose ?? false;
  const clientFactory = options.clientFactory ?? createClient;
  const client = await clientFactory(profile, verbose);
  const remotePath = joinRemotePath(localConfig.remoteRoot, target.relativePath);
  const localDir = path.dirname(target.absolutePath);

  try {
    await mkdir(localDir, { recursive: true });

    try {
      await client.downloadTo(target.absolutePath, remotePath);
    } catch (error) {
      throw createTransferError("download", target.relativePath, remotePath, error);
    }

    if (!verbose) {
      process.stdout.write(`download ${target.relativePath} <- ${remotePath}\n`);
    }
  } finally {
    client.close();
  }
}

export async function downloadAllFiles(repoRoot, localConfig, profile, options = {}) {
  const verbose = options.verbose ?? false;
  const clientFactory = options.clientFactory ?? createClient;
  const client = await clientFactory(profile, verbose);
  const remoteRoot = normalizeRemoteRoot(localConfig.remoteRoot);

  try {
    await mkdir(repoRoot, { recursive: true });

    try {
      await client.downloadToDir(repoRoot, remoteRoot);
    } catch (error) {
      throw createTransferError("download-all", ".", remoteRoot, error);
    }

    if (!verbose) {
      process.stdout.write(`download-all ${repoRoot} <- ${remoteRoot}\n`);
    }
  } finally {
    client.close();
  }
}

export async function executeTransferPlan(plan, localConfig, profile, options = {}) {
  const verbose = options.verbose ?? false;
  const deleteSameFile = options.deleteSameFile ?? false;
  const clientFactory = options.clientFactory ?? createClient;
  const client = await clientFactory(profile, verbose);

  try {
    for (const upload of plan.uploads) {
      const remotePath = joinRemotePath(localConfig.remoteRoot, upload.relativePath);
      const remoteDir = path.posix.dirname(remotePath);

      try {
        await client.ensureDir(remoteDir);
      } catch (error) {
        throw createTransferError("ensure-dir", upload.relativePath, remoteDir, error);
      }

      await uploadWithReplaceRetry(client, upload, remotePath, {
        deleteSameFile
      });

      if (!verbose) {
        process.stdout.write(`upload ${upload.relativePath} -> ${remotePath}\n`);
      }
    }

    for (const deletion of plan.deletions) {
      const remotePath = joinRemotePath(localConfig.remoteRoot, deletion.relativePath);
      try {
        await client.remove(remotePath);
        process.stdout.write(`delete ${deletion.relativePath} -> ${remotePath}\n`);
      } catch (error) {
        if (!isMissingRemoteError(error)) {
          throw createTransferError("delete", deletion.relativePath, remotePath, error);
        }

        process.stdout.write(`skip-delete ${deletion.relativePath} -> ${remotePath} (tidak ada di remote)\n`);
      }
    }
  } finally {
    client.close();
  }
}
