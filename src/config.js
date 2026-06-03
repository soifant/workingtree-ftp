import os from "node:os";
import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

export const GLOBAL_DIR_NAME = ".workingtree-ftp-uploader";
export const GLOBAL_PROFILES_FILE = "profiles.json";
export const LOCAL_CONFIG_FILE = ".workingtree-ftp.json";
export const LEGACY_GLOBAL_DIR_NAME = ".uncommit-ftp-uploader";
export const LEGACY_LOCAL_CONFIG_FILE = ".uncommit-ftp.json";

export function getGlobalConfigDir() {
  return path.join(os.homedir(), GLOBAL_DIR_NAME);
}

export function getLegacyGlobalConfigDir() {
  return path.join(os.homedir(), LEGACY_GLOBAL_DIR_NAME);
}

export function getGlobalProfilesPath() {
  return path.join(getGlobalConfigDir(), GLOBAL_PROFILES_FILE);
}

export function getLegacyGlobalProfilesPath() {
  return path.join(getLegacyGlobalConfigDir(), GLOBAL_PROFILES_FILE);
}

export function getLocalConfigPath(repoRoot) {
  return path.join(repoRoot, LOCAL_CONFIG_FILE);
}

export function getLegacyLocalConfigPath(repoRoot) {
  return path.join(repoRoot, LEGACY_LOCAL_CONFIG_FILE);
}

async function existingFilePath(filePaths) {
  for (const filePath of filePaths) {
    try {
      await stat(filePath);
      return filePath;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return null;
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON tidak valid di ${filePath}`);
    }

    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeProfilesShape(value) {
  if (!value) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Format profile global tidak valid.");
  }

  if (value.profiles && typeof value.profiles === "object" && !Array.isArray(value.profiles)) {
    return value.profiles;
  }

  return value;
}

function validateProfileDefinition(name, profile) {
  if (!name) {
    throw new Error("Nama profile wajib diisi.");
  }

  if (!profile.host) {
    throw new Error(`Profile "${name}" harus memiliki host.`);
  }

  if (!profile.user) {
    throw new Error(`Profile "${name}" harus memiliki user.`);
  }

  if (!profile.password && !profile.passwordEnv) {
    throw new Error(`Profile "${name}" harus punya password atau passwordEnv.`);
  }
}

export async function readGlobalProfiles() {
  const filePath =
    (await existingFilePath([getGlobalProfilesPath(), getLegacyGlobalProfilesPath()])) ||
    getGlobalProfilesPath();
  const raw = await readJson(filePath, { profiles: {} });
  return normalizeProfilesShape(raw);
}

export async function writeGlobalProfiles(profiles) {
  await writeJson(getGlobalProfilesPath(), { profiles });
}

export async function upsertGlobalProfile(name, profile) {
  validateProfileDefinition(name, profile);
  const profiles = await readGlobalProfiles();
  profiles[name] = {
    host: profile.host,
    user: profile.user,
    password: profile.password,
    passwordEnv: profile.passwordEnv,
    port: Number(profile.port || 21),
    secure: Boolean(profile.secure)
  };
  await writeGlobalProfiles(profiles);
  return profiles[name];
}

export async function removeGlobalProfile(name) {
  const profiles = await readGlobalProfiles();
  if (!profiles[name]) {
    return false;
  }

  delete profiles[name];
  await writeGlobalProfiles(profiles);
  return true;
}

export async function readLocalConfig(repoRoot) {
  const configPath =
    (await existingFilePath([getLocalConfigPath(repoRoot), getLegacyLocalConfigPath(repoRoot)])) ||
    getLocalConfigPath(repoRoot);
  const config = await readJson(configPath);

  if (!config) {
    throw new Error(
      `Config project tidak ditemukan di ${configPath}. Jalankan "wftp init --profile <nama> --remote-root <path>".`
    );
  }

  if (!config.profile) {
    throw new Error(`Field "profile" wajib diisi di ${configPath}.`);
  }

  if (!config.remoteRoot) {
    throw new Error(`Field "remoteRoot" wajib diisi di ${configPath}.`);
  }

  if (config.ignore && !Array.isArray(config.ignore)) {
    throw new Error(`Field "ignore" harus berupa array di ${configPath}.`);
  }

  return {
    ...config,
    configPath
  };
}

export async function writeLocalConfig(repoRoot, config, { force = false } = {}) {
  const configPath = getLocalConfigPath(repoRoot);

  if (!force) {
    const existingPath = await existingFilePath([configPath, getLegacyLocalConfigPath(repoRoot)]);
    if (existingPath) {
      throw new Error(`Config project sudah ada di ${existingPath}. Gunakan --force untuk menimpa.`);
    }
  }

  await writeJson(configPath, {
    profile: config.profile,
    remoteRoot: config.remoteRoot,
    ...(config.ignore ? { ignore: config.ignore } : {})
  });

  return configPath;
}

export async function ensureGitignoreEntry(repoRoot, entry) {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let current = "";

  try {
    current = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const lines = current.split(/\r?\n/).filter(Boolean);
  if (!lines.includes(entry)) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, `${current}${prefix}${entry}\n`, "utf8");
  }

  return gitignorePath;
}

export function maskProfile(profile) {
  if (!profile) {
    return null;
  }

  return {
    ...profile,
    password: profile.password ? "********" : undefined
  };
}
