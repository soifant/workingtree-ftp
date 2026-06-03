import path from "node:path";
import ftp from "basic-ftp";

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

async function createClient(profile, verbose) {
  const client = new ftp.Client(30_000);
  client.ftp.verbose = false;

  if (verbose) {
    client.trackProgress((info) => {
      if (info.type === "upload") {
        process.stdout.write(`uploaded ${info.name} (${info.bytesOverall} bytes)\n`);
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

export async function executeTransferPlan(plan, localConfig, profile, options = {}) {
  const verbose = options.verbose ?? false;
  const client = await createClient(profile, verbose);

  try {
    for (const upload of plan.uploads) {
      const remotePath = joinRemotePath(localConfig.remoteRoot, upload.relativePath);
      const remoteDir = path.posix.dirname(remotePath);

      await client.ensureDir(remoteDir);
      await client.uploadFrom(upload.absolutePath, remotePath);

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
          throw error;
        }

        process.stdout.write(`skip-delete ${deletion.relativePath} -> ${remotePath} (tidak ada di remote)\n`);
      }
    }
  } finally {
    client.close();
  }
}
