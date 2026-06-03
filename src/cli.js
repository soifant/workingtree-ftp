#!/usr/bin/env node

import { Command } from "commander";
import { createRequire } from "node:module";
import path from "node:path";
import {
  ensureGitignoreEntry,
  getGlobalProfilesPath,
  getLocalConfigPath,
  maskProfile,
  readGlobalProfiles,
  readLocalConfig,
  removeGlobalProfile,
  upsertGlobalProfile,
  writeLocalConfig
} from "./config.js";
import { executeTransferPlan } from "./ftp.js";
import { findGitRoot, readWorkingTreeChanges } from "./git.js";
import { buildTransferPlan } from "./planner.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const program = new Command();

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
}

function wrap(action) {
  return async (...args) => {
    try {
      await action(...args);
    } catch (error) {
      fail(error.message);
    }
  };
}

function printPlan(plan) {
  process.stdout.write(`Uploads: ${plan.uploads.length}\n`);
  for (const item of plan.uploads) {
    process.stdout.write(`  upload  ${item.relativePath} [${item.reason}]\n`);
  }

  process.stdout.write(`Deletes: ${plan.deletions.length}\n`);
  for (const item of plan.deletions) {
    process.stdout.write(`  delete  ${item.relativePath} [${item.reason}]\n`);
  }

  if (plan.skipped.length > 0) {
    process.stdout.write(`Skipped: ${plan.skipped.length}\n`);
    for (const item of plan.skipped) {
      process.stdout.write(`  skip    ${item.relativePath} [${item.reason}]\n`);
    }
  }

  if (plan.conflicts.length > 0) {
    process.stdout.write(`Conflicts: ${plan.conflicts.length}\n`);
    for (const item of plan.conflicts) {
      process.stdout.write(`  conflict ${item.relativePath} [${item.code}]\n`);
    }
  }
}

async function loadProjectContext(startDir) {
  const repoRoot = await findGitRoot(startDir);
  const localConfig = await readLocalConfig(repoRoot);
  const profiles = await readGlobalProfiles();
  const profile = profiles[localConfig.profile];

  if (!profile) {
    throw new Error(
      `Profile "${localConfig.profile}" tidak ditemukan di ${getGlobalProfilesPath()}. Jalankan "wftp profile set ${localConfig.profile} ...".`
    );
  }

  return {
    repoRoot,
    localConfig,
    profile
  };
}

async function loadPlan(options) {
  const context = await loadProjectContext(process.cwd());
  const changes = await readWorkingTreeChanges(context.repoRoot);
  const plan = await buildTransferPlan(context.repoRoot, changes, {
    includeUntracked: options.includeUntracked,
    deleteRemoved: options.deleteRemoved,
    excludePaths: context.localConfig.ignore
  });

  return {
    ...context,
    changes,
    plan
  };
}

program
  .name("wftp")
  .description("Upload file working tree Git yang belum di-commit ke FTP.")
  .version(version);

const profile = program.command("profile").description("Kelola profile FTP global.");

profile
  .command("set")
  .argument("<name>", "Nama profile")
  .requiredOption("--host <host>", "FTP host")
  .requiredOption("--user <user>", "FTP username")
  .option("--password <password>", "FTP password langsung di file profile")
  .option("--password-env <envName>", "Nama environment variable yang menyimpan password")
  .option("--port <port>", "FTP port", "21")
  .option("--secure", "Gunakan FTPS")
  .action(
    wrap(async (name, options) => {
      if (!options.password && !options.passwordEnv) {
        throw new Error("Gunakan --password atau --password-env.");
      }

      const saved = await upsertGlobalProfile(name, options);
      process.stdout.write(
        `Profile "${name}" tersimpan di ${getGlobalProfilesPath()}\n${JSON.stringify(maskProfile(saved), null, 2)}\n`
      );
    })
  );

profile
  .command("list")
  .description("Daftar profile global")
  .action(
    wrap(async () => {
      const profiles = await readGlobalProfiles();
      const names = Object.keys(profiles).sort();

      if (names.length === 0) {
        process.stdout.write(`Belum ada profile di ${getGlobalProfilesPath()}\n`);
        return;
      }

      for (const name of names) {
        const item = profiles[name];
        process.stdout.write(`${name}  ${item.user}@${item.host}:${item.port || 21}\n`);
      }
    })
  );

profile
  .command("show")
  .argument("<name>", "Nama profile")
  .action(
    wrap(async (name) => {
      const profiles = await readGlobalProfiles();
      const item = profiles[name];
      if (!item) {
        throw new Error(`Profile "${name}" tidak ditemukan.`);
      }

      process.stdout.write(`${JSON.stringify(maskProfile(item), null, 2)}\n`);
    })
  );

profile
  .command("remove")
  .argument("<name>", "Nama profile")
  .action(
    wrap(async (name) => {
      const removed = await removeGlobalProfile(name);
      if (!removed) {
        throw new Error(`Profile "${name}" tidak ditemukan.`);
      }

      process.stdout.write(`Profile "${name}" dihapus dari ${getGlobalProfilesPath()}\n`);
    })
  );

program
  .command("init")
  .description("Buat config lokal untuk repo saat ini.")
  .requiredOption("--profile <name>", "Nama profile global yang dipakai repo ini")
  .requiredOption("--remote-root <path>", "Folder root di FTP")
  .option("--force", "Timpa config lokal jika sudah ada")
  .option("--gitignore", "Tambahkan config lokal ke .gitignore", true)
  .option("--no-gitignore", "Jangan ubah .gitignore")
  .action(
    wrap(async (options) => {
      const repoRoot = await findGitRoot(process.cwd());
      const profiles = await readGlobalProfiles();
      if (!profiles[options.profile]) {
        throw new Error(
          `Profile "${options.profile}" tidak ditemukan di ${getGlobalProfilesPath()}. Buat dulu dengan "wftp profile set ${options.profile} ...".`
        );
      }

      const configPath = await writeLocalConfig(
        repoRoot,
        {
          profile: options.profile,
          remoteRoot: options.remoteRoot
        },
        {
          force: Boolean(options.force)
        }
      );

      process.stdout.write(`Config project dibuat di ${configPath}\n`);
      if (options.gitignore) {
        const gitignorePath = await ensureGitignoreEntry(repoRoot, path.basename(configPath));
        process.stdout.write(`Entry ${path.basename(configPath)} ditambahkan ke ${gitignorePath}\n`);
      }
    })
  );

program
  .command("config")
  .description("Tampilkan config lokal repo saat ini.")
  .action(
    wrap(async () => {
      const repoRoot = await findGitRoot(process.cwd());
      const localConfig = await readLocalConfig(repoRoot);
      process.stdout.write(
        `${JSON.stringify(
          {
            repoRoot,
            ...localConfig
          },
          null,
          2
        )}\n`
      );
    })
  );

program
  .command("status")
  .description("Lihat file working tree yang akan diproses.")
  .option("--delete-removed", "Masukkan file deleted/renamed lama untuk dihapus di remote")
  .option("--no-include-untracked", "Jangan upload file untracked")
  .action(
    wrap(async (options) => {
      const result = await loadPlan(options);
      process.stdout.write(`Repo: ${result.repoRoot}\n`);
      process.stdout.write(`Profile: ${result.localConfig.profile}\n`);
      process.stdout.write(`Remote root: ${result.localConfig.remoteRoot}\n`);
      process.stdout.write(`Changes detected: ${result.changes.length}\n`);
      printPlan(result.plan);

      if (result.plan.conflicts.length > 0) {
        process.exitCode = 2;
      }
    })
  );

program
  .command("upload")
  .description("Upload perubahan working tree ke FTP.")
  .option("--dry-run", "Hanya tampilkan aksi tanpa upload")
  .option("--delete-removed", "Hapus file remote untuk file lokal yang deleted atau renamed")
  .option("--no-include-untracked", "Jangan upload file untracked")
  .option("--verbose", "Tampilkan output detail proses FTP")
  .action(
    wrap(async (options) => {
      const result = await loadPlan(options);

      process.stdout.write(`Repo: ${result.repoRoot}\n`);
      process.stdout.write(`Profile: ${result.localConfig.profile}\n`);
      process.stdout.write(`Remote root: ${result.localConfig.remoteRoot}\n`);
      printPlan(result.plan);

      if (result.plan.conflicts.length > 0) {
        throw new Error("Working tree memiliki conflict. Selesaikan conflict sebelum upload.");
      }

      if (result.plan.uploads.length === 0 && result.plan.deletions.length === 0) {
        process.stdout.write("Tidak ada perubahan yang perlu diproses.\n");
        return;
      }

      if (options.dryRun) {
        process.stdout.write("Dry run selesai. Tidak ada koneksi FTP yang dilakukan.\n");
        return;
      }

      await executeTransferPlan(result.plan, result.localConfig, result.profile, {
        verbose: Boolean(options.verbose)
      });
      process.stdout.write("Upload selesai.\n");
    })
  );

await program.parseAsync(process.argv);
