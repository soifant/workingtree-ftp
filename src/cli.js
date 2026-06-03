#!/usr/bin/env node

import { Command } from "commander";
import { createRequire } from "node:module";
import path from "node:path";
import {
  ensureGitignoreEntry,
  getGlobalProfilesPath,
  maskProfile,
  readGlobalProfiles,
  readLocalConfig,
  removeGlobalProfile,
  upsertGlobalProfile,
  writeLocalConfig
} from "./config.js";
import { downloadAllFiles, downloadSingleFile, executeTransferPlan } from "./ftp.js";
import { findGitRoot, readWorkingTreeChanges } from "./git.js";
import { buildTransferPlan } from "./planner.js";
import { createReport } from "./report.js";
import {
  buildSingleDeletePlan,
  buildSingleDownloadTarget,
  buildSingleUploadPlan
} from "./single-target.js";

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

function printDownloadTarget(target) {
  process.stdout.write("Downloads: 1\n");
  process.stdout.write(`  download ${target.relativePath}\n`);
}

function printDownloadAll(repoRoot, remoteRoot) {
  process.stdout.write("Downloads: all\n");
  process.stdout.write(`  download-all ${remoteRoot} -> ${repoRoot}\n`);
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

function printProjectContext(result) {
  process.stdout.write(`Repo: ${result.repoRoot}\n`);
  process.stdout.write(`Profile: ${result.localConfig.profile}\n`);
  process.stdout.write(`Remote root: ${result.localConfig.remoteRoot}\n`);
}

program
  .name("wftp")
  .description("Push working tree Git, transfer file tunggal via FTP, dan buat report perubahan Git.")
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
  .description("Lihat file working tree yang akan diproses oleh command push.")
  .option("--delete-removed", "Masukkan file deleted/renamed lama untuk dihapus di remote")
  .option("--no-include-untracked", "Jangan upload file untracked")
  .action(
    wrap(async (options) => {
      const result = await loadPlan(options);
      printProjectContext(result);
      process.stdout.write(`Changes detected: ${result.changes.length}\n`);
      printPlan(result.plan);

      if (result.plan.conflicts.length > 0) {
        process.exitCode = 2;
      }
    })
  );

program
  .command("push")
  .description("Push perubahan working tree ke FTP.")
  .option("--dry-run", "Hanya tampilkan aksi tanpa upload")
  .option("--delete-removed", "Hapus file remote untuk file lokal yang deleted atau renamed")
  .option(
    "--delete-same-file",
    "Jika overwrite upload gagal karena file remote yang sama, hapus file remote lalu coba upload ulang"
  )
  .option("--no-include-untracked", "Jangan upload file untracked")
  .option("--verbose", "Tampilkan output detail proses FTP")
  .action(
    wrap(async (options) => {
      const result = await loadPlan(options);

      printProjectContext(result);
      printPlan(result.plan);

      if (result.plan.conflicts.length > 0) {
        throw new Error("Working tree memiliki conflict. Selesaikan conflict sebelum push.");
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
        deleteSameFile: Boolean(options.deleteSameFile),
        verbose: Boolean(options.verbose)
      });
      process.stdout.write("Push selesai.\n");
    })
  );

program
  .command("upload")
  .description("Upload satu file ke FTP.")
  .argument("<path>", "Path file yang akan diupload")
  .option("--dry-run", "Hanya tampilkan aksi tanpa upload")
  .option(
    "--delete-same-file",
    "Jika overwrite upload gagal karena file remote yang sama, hapus file remote lalu coba upload ulang"
  )
  .option("--verbose", "Tampilkan output detail proses FTP")
  .action(
    wrap(async (filePath, options) => {
      const context = await loadProjectContext(process.cwd());
      const plan = await buildSingleUploadPlan(context.repoRoot, filePath, process.cwd());
      const result = {
        ...context,
        plan
      };

      printProjectContext(result);
      printPlan(result.plan);

      if (options.dryRun) {
        process.stdout.write("Dry run selesai. Tidak ada koneksi FTP yang dilakukan.\n");
        return;
      }

      await executeTransferPlan(result.plan, result.localConfig, result.profile, {
        deleteSameFile: Boolean(options.deleteSameFile),
        verbose: Boolean(options.verbose)
      });
      process.stdout.write("Upload selesai.\n");
    })
  );

program
  .command("delete")
  .description("Hapus satu file remote dari FTP.")
  .argument("<path>", "Path file yang akan dihapus di remote")
  .option("--dry-run", "Hanya tampilkan aksi tanpa delete remote")
  .action(
    wrap(async (filePath, options) => {
      const context = await loadProjectContext(process.cwd());
      const plan = buildSingleDeletePlan(context.repoRoot, filePath, process.cwd());
      const result = {
        ...context,
        plan
      };

      printProjectContext(result);
      printPlan(result.plan);

      if (options.dryRun) {
        process.stdout.write("Dry run selesai. Tidak ada koneksi FTP yang dilakukan.\n");
        return;
      }

      await executeTransferPlan(result.plan, result.localConfig, result.profile, {});
      process.stdout.write("Delete selesai.\n");
    })
  );

program
  .command("download")
  .description("Download satu file atau seluruh remote root dari FTP.")
  .argument("[path]", "Path file yang akan didownload")
  .option("--all", "Download seluruh isi remote root ke root repository lokal")
  .option("--dry-run", "Hanya tampilkan aksi tanpa download")
  .option("--verbose", "Tampilkan output detail proses FTP")
  .action(
    wrap(async (filePath, options) => {
      const context = await loadProjectContext(process.cwd());
      const wantsAll = Boolean(options.all);
      const hasPath = Boolean(filePath);

      if (wantsAll === hasPath) {
        throw new Error('Gunakan salah satu: "wftp download <path>" atau "wftp download --all".');
      }

      printProjectContext(context);

      if (wantsAll) {
        printDownloadAll(context.repoRoot, context.localConfig.remoteRoot);

        if (options.dryRun) {
          process.stdout.write("Dry run selesai. Tidak ada koneksi FTP yang dilakukan.\n");
          return;
        }

        await downloadAllFiles(context.repoRoot, context.localConfig, context.profile, {
          verbose: Boolean(options.verbose)
        });
        process.stdout.write("Download selesai.\n");
        return;
      }

      const target = buildSingleDownloadTarget(context.repoRoot, filePath, process.cwd());
      printDownloadTarget(target);

      if (options.dryRun) {
        process.stdout.write("Dry run selesai. Tidak ada koneksi FTP yang dilakukan.\n");
        return;
      }

      await downloadSingleFile(target, context.localConfig, context.profile, {
        verbose: Boolean(options.verbose)
      });
      process.stdout.write("Download selesai.\n");
    })
  );

program
  .command("report")
  .description("Simpan report perubahan working tree atau commit ke file txt.")
  .option("--uncommit", "Simpan report file yang belum di-commit")
  .option("--start <id>", "Commit awal untuk report range")
  .option("--end <id>", "Commit akhir untuk report range")
  .option("--line", "Sertakan line number untuk file edit atau delete")
  .option("--name <name>", "Nama file report")
  .option("--name-date", "Tambahkan suffix tanggal YYYYMMDD ke nama file custom")
  .action(
    wrap(async (options) => {
      const repoRoot = await findGitRoot(process.cwd());
      const result = await createReport(repoRoot, options);

      if (result.kind === "noop") {
        process.stdout.write(`${result.message}\n`);
        return;
      }

      process.stdout.write(`Report tersimpan di ${result.filePath}\n`);
    })
  );

await program.parseAsync(process.argv);
