# workingtree-ftp

Node.js CLI for uploading Git working tree changes to an FTP or FTPS server without waiting for a commit. This tool is useful for legacy hosting workflows that still rely on FTP but want Git to decide which files changed.

The main command provided by this package is `wftp`.

## Overview

`wftp` reads changes from `git status` and builds a transfer plan:

- `modified`, `added`, `copied`, `type-changed`, and `untracked` files are uploaded.
- `deleted` files are not removed from the remote server unless you add `--delete-removed`.
- Renamed files upload the new path. The old path is removed only when `--delete-removed` is used.
- Merge conflicts stop the upload so the tool does not run against an ambiguous repository state.
- Metadata files such as `.gitignore`, `.gitattributes`, `.gitmodules`, `.workingtree-ftp.json`, and `.uncommit-ftp.json` are excluded by default.

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

5. Run the upload:

```bash
wftp upload
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

### `wftp upload`

Runs the FTP transfer based on the current working tree.

```bash
wftp upload
wftp upload --dry-run
wftp upload --delete-removed
wftp upload --verbose
```

Options:

- `--dry-run`: only print the plan, without connecting to FTP
- `--delete-removed`: remove remote files for deleted local files or old rename paths
- `--no-include-untracked`: ignore untracked files
- `--verbose`: show more detailed FTP progress output

Important behavior:

- Upload fails if the working tree contains merge conflicts.
- If there are no changes, the command finishes without opening an FTP connection.
- Remote delete failures caused by a missing remote file are reported as `skip-delete`, not as fatal errors.

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
