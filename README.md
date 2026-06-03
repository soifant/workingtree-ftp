# workingtree-ftp

Node.js CLI for pushing Git working tree changes, uploading single files, deleting single remote files, downloading remote files, and exporting change reports from Git. This tool is useful for legacy hosting workflows that still rely on FTP but want Git to decide which files changed.

The main command provided by this package is `wftp`.

## Overview

`wftp push` reads changes from `git status` and builds a transfer plan:

- `modified`, `added`, `copied`, `type-changed`, and `untracked` files are uploaded.
- `deleted` files are not removed from the remote server unless you add `--delete-removed`.
- Renamed files upload the new path. The old path is removed only when `--delete-removed` is used.
- Merge conflicts stop the upload so the tool does not run against an ambiguous repository state.
- Metadata files such as `.gitignore`, `.gitattributes`, `.gitmodules`, `.workingtree-ftp.json`, and `.uncommit-ftp.json` are excluded by default.
- `wftp upload <path>` uploads a single file directly, as long as the file is inside the current Git repository.
- `wftp delete <path>` deletes one remote file using the same repository-relative path mapping.
- `wftp download <path>` downloads one remote file into the matching local path inside the repository.
- `wftp download --all` downloads the entire `remoteRoot` into the local repository root.
- `wftp report` exports a `.txt` report of committed or uncommitted Git changes.

## Requirements

- Node.js `>= 20`
- Git available in `PATH`
- Access to an FTP or FTPS server

## Installation

Install globally from the package:

```bash
npm install -g workingtree-ftp
```

For development from this project folder:

```bash
npm install
npm link
```

After that, the `wftp` command will be available globally.

## Quick Start

1. Create a global FTP profile:

```bash
wftp profile set client-a \
  --host ftp.client-a.com \
  --user deploy-client-a \
  --password-env FTP_CLIENT_A_PASS
```

2. Set the password as an environment variable:

```bash
export FTP_CLIENT_A_PASS='secret'
```

In PowerShell:

```powershell
$env:FTP_CLIENT_A_PASS = "secret"
```

3. Initialize the current repository:

```bash
wftp init --profile client-a --remote-root /public_html/app
```

4. Preview which files will be processed:

```bash
wftp status
```

5. Push the working tree changes:

```bash
wftp push
```

To upload one file directly:

```bash
wftp upload src/app.js
```

To download one file directly:

```bash
wftp download src/app.js
```

To export a report of uncommitted files:

```bash
wftp report --uncommit
```

## Configuration Locations

The tool uses two configuration levels.

### 1. Global profiles

Stored in the user's home directory:

```text
~/.workingtree-ftp/profiles.json
```

Example:

```json
{
  "profiles": {
    "client-a": {
      "host": "ftp.client-a.com",
      "user": "deploy-client-a",
      "passwordEnv": "FTP_CLIENT_A_PASS",
      "port": 21,
      "secure": false
    }
  }
}
```

Supported fields:

- `host`: FTP hostname
- `user`: FTP username
- `password`: plain text password stored in the profile
- `passwordEnv`: environment variable name containing the password
- `port`: defaults to `21`
- `secure`: `true` to use FTPS

### 2. Local repository config

Stored in the Git repository root:

```text
.workingtree-ftp.json
```

Example:

```json
{
  "profile": "client-a",
  "remoteRoot": "/public_html/app",
  "ignore": [
    "storage/logs/app.log",
    "tmp/debug.txt"
  ]
}
```

Supported fields:

- `profile`: name of the global profile used by this repository
- `remoteRoot`: target directory on the server
- `ignore`: list of repository-relative paths that should be skipped

When you run `wftp init`, this file can be added to `.gitignore` automatically.

## Commands

### `wftp profile set <name>`

Creates or updates a global FTP profile.

```bash
wftp profile set client-a \
  --host ftp.client-a.com \
  --user deploy-client-a \
  --password-env FTP_CLIENT_A_PASS \
  --port 21 \
  --secure
```

Options:

- `--host <host>`: required
- `--user <user>`: required
- `--password <password>`: store the password directly in the profile file
- `--password-env <envName>`: read the password from an environment variable
- `--port <port>`: defaults to `21`
- `--secure`: use FTPS

At least one of `--password` or `--password-env` must be provided.

### `wftp profile list`

Shows all available global profiles.

```bash
wftp profile list
```

### `wftp profile show <name>`

Shows profile details with the password masked.

```bash
wftp profile show client-a
```

### `wftp profile remove <name>`

Deletes a global profile.

```bash
wftp profile remove client-a
```

### `wftp init`

Creates the local config file in the active Git repository.

```bash
wftp init --profile client-a --remote-root /public_html/app
```

Options:

- `--profile <name>`: required
- `--remote-root <path>`: required
- `--force`: overwrite an existing config
- `--gitignore`: add the config file to `.gitignore` (default)
- `--no-gitignore`: do not modify `.gitignore`

### `wftp config`

Prints the local config for the current repository.

```bash
wftp config
```

### `wftp status`

Shows a preview of the transfer plan without connecting to FTP.

```bash
wftp status
wftp status --delete-removed
wftp status --no-include-untracked
```

Options:

- `--delete-removed`: include deleted files or old rename paths as remote deletions
- `--no-include-untracked`: ignore untracked files

The output is grouped into:

- `Uploads`
- `Deletes`
- `Skipped`
- `Conflicts`

If conflicts are found, this command returns exit code `2`.

### `wftp push`

Runs the FTP transfer based on the current working tree.

```bash
wftp push
wftp push --dry-run
wftp push --delete-removed
wftp push --delete-same-file
wftp push --verbose
```

Options:

- `--dry-run`: only print the plan, without connecting to FTP
- `--delete-removed`: remove remote files for deleted local files or old rename paths
- `--delete-same-file`: if overwriting an existing remote file fails, delete the remote file and retry the upload once
- `--no-include-untracked`: ignore untracked files
- `--verbose`: show more detailed FTP progress output

Important behavior:

- Upload fails if the working tree contains merge conflicts.
- If there are no changes, the command finishes without opening an FTP connection.
- `--delete-same-file` only applies to upload failures that look like an overwrite conflict on the same remote path.
- Remote delete failures caused by a missing remote file are reported as `skip-delete`, not as fatal errors.

### `wftp upload <path>`

Uploads a single file directly to the remote path derived from the repository root and `remoteRoot`.

```bash
wftp upload src/app.js
wftp upload .\src\app.js --dry-run
wftp upload src/app.js --delete-same-file --verbose
```

Options:

- `--dry-run`: only print the upload plan, without connecting to FTP
- `--delete-same-file`: if overwriting an existing remote file fails, delete the remote file and retry the upload once
- `--verbose`: show more detailed FTP progress output

Important behavior:

- The target file must be inside the current Git repository.
- The target must be a regular file.
- This command does not read `git status`; it uploads the exact file path you pass in.

### `wftp delete <path>`

Deletes one remote file using the same repository-relative path mapping as `upload`.

```bash
wftp delete src/old-file.js
wftp delete .\src\old-file.js --dry-run
```

Options:

- `--dry-run`: only print the delete plan, without connecting to FTP

Important behavior:

- The path must resolve inside the current Git repository.
- The local file does not need to exist.
- If the remote file does not exist, the result is reported as `skip-delete`, not as a fatal error.

### `wftp download <path>`

Downloads one remote file to the matching local path inside the current repository.

```bash
wftp download src/app.js
wftp download .\assets\logo.png --dry-run
wftp download src/app.js --verbose
```

Options:

- `--dry-run`: only print the download plan, without connecting to FTP
- `--verbose`: show more detailed FTP progress output

Important behavior:

- The target path must resolve inside the current Git repository.
- Parent directories are created automatically if needed.
- This command downloads exactly the path you pass in from `remoteRoot`.

### `wftp download --all`

Downloads the full contents of `remoteRoot` into the local repository root.

```bash
wftp download --all
wftp download --all --dry-run
wftp download --all --verbose
```

Options:

- `--all`: required when downloading the entire remote root
- `--dry-run`: only print the planned action, without connecting to FTP
- `--verbose`: show more detailed FTP progress output

Important behavior:

- This downloads the entire configured remote root recursively.
- Local files inside the repository can be overwritten by the downloaded content.
- Use either `wftp download <path>` or `wftp download --all`, not both.

### `wftp report`

Exports a `.txt` report describing changed files from Git history or from the current working tree.

```bash
wftp report
wftp report --uncommit
wftp report --start abc123 --end def456
wftp report --uncommit --line
wftp report --name client-audit --name-date
```

Options:

- `--uncommit`: export files that have not been committed yet
- `--start <id>`: starting commit for an explicit commit range
- `--end <id>`: ending commit for an explicit commit range
- `--line`: include line numbers for `EDIT` and `DEL` entries
- `--name <name>`: use a custom output file name
- `--name-date`: append `_YYYYMMDD` to the custom file name, requires `--name`

Default behavior:

- On the first `wftp report` run without extra options, the tool exports all committed changes in the repository.
- On later plain `wftp report` runs, it exports only commits after the last saved automatic report cursor.
- The last automatic report cursor is stored in `.git/workingtree-ftp-report.json`.

Naming behavior:

- With `--name report-audit`, the file name becomes `report-audit.txt`
- With `--name report-audit --name-date`, the file name becomes `report-audit_YYYYMMDD.txt`
- Without `--name`, the file name becomes `REPOSITORYNAME_YYYYMMDD.txt`

Format behavior:

- Without `--line`, each section contains only `[ADD]`, `[EDIT]`, or `[DEL]` entries grouped by commit message
- With `--line`, `EDIT` and `DEL` entries also include a `LINE 1,2,3` line when line numbers can be derived from Git diff hunks
- `wftp report --uncommit` uses a single section titled `UNCOMMITTED CHANGES`

## How File Detection Works

The tool reads the output of:

```bash
git status --porcelain=1 -z -uall
```

Each entry is mapped to an action:

- `M`, `A`, `C`, `T`: upload
- `??`: upload when untracked files are enabled
- `D`: delete only when `--delete-removed` is used
- `R`: upload the new path, delete the old path only when `--delete-removed` is used
- `U`, `AA`, `DD`: treated as conflicts

Before uploading, local paths are checked again to make sure the target is a regular file.

## Security

The recommended approach is to use `--password-env` instead of `--password`, so the password is not stored directly in the JSON file.

Safer example:

```bash
wftp profile set client-a \
  --host ftp.client-a.com \
  --user deploy-client-a \
  --password-env FTP_CLIENT_A_PASS
```

If a profile uses `passwordEnv`, the upload fails when the referenced environment variable is not available in the current shell.

## Compatibility

The current version still reads older config locations as fallbacks:

- Legacy local config: `.uncommit-ftp.json`
- Previous global profiles: `~/.workingtree-ftp-uploader/profiles.json`
- Legacy global profiles: `~/.uncommit-ftp-uploader/profiles.json`

This is useful when migrating from the previous tool name.

## Development

Run tests:

```bash
npm test
```

Run the CLI directly from source:

```bash
node src/cli.js --help
```

## Troubleshooting

### `Failed to run git rev-parse --show-toplevel`

This usually means the command was run outside a Git repository, or Git is not available in `PATH`.

### `Project config not found`

The repository has not been initialized yet. Run:

```bash
wftp init --profile <name> --remote-root <path>
```

### `Profile "<name>" not found`

The global profile does not exist yet. Run:

```bash
wftp profile set <name> --host <host> --user <user> --password-env <ENV_NAME>
```

### `Environment variable <NAME> not found`

The profile expects its password from an environment variable, but that variable is not set in the current shell.
