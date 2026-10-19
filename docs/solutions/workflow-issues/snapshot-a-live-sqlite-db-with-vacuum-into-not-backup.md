---
title: "Snapshot the live SQLite database with VACUUM INTO, not the sqlite3 .backup command"
date: 2026-10-19
category: workflow-issues
module: production-database
problem_type: workflow_issue
component: database
severity: medium
applies_when:
  - Snapshotting the production better-ccflare.db before a deploy, a migration or a manual repair
  - Writing or reviewing a cron job or script that backs up the database while the server runs
  - Any hot backup of a continuously written WAL-mode SQLite file
symptoms:
  - A pre-deploy sqlite3 .backup of a 4.5 GB database ran for over two and a half hours without finishing
  - The partial backup file stayed close to the source size the whole time, so its size looked like progress
  - The deploy waiting on the snapshot stalled, and production kept serving the old commit
root_cause: incorrect_assumption
resolution_type: workflow_improvement
related_components:
  - development_workflow
  - documentation
framework_version: "sqlite3 CLI 3.45.1"
tags:
  - sqlite
  - backup
  - vacuum-into
  - wal
  - deploy
  - hot-backup
  - production-database
---

# Snapshot the live SQLite database with VACUUM INTO, not the sqlite3 .backup command

## Context

`scripts/deploy-ccflare.sh` backs up binaries and the version pin, not the database, so a pre-deploy database snapshot is a separate operator step.

On 2026-10-18 the pre-deploy step for issue #541 snapshotted the production database (`~/.config/better-ccflare/better-ccflare.db`, 4,499,165,184 bytes, WAL mode) with:

```bash
sqlite3 "$db" ".backup '$backup'"
```

The proxy wrote to the database the whole time, and the host's load average was between 39 and 44. The backup started at 22:53:22. At 01:25 the target file was 4,482,252,800 bytes with a 1,024-byte `-journal` beside it and had still not finished, so it was terminated at about 01:27 (exit 143). The deploy script ran the snapshot before the deploy, so production stayed on the old commit for that whole window.

The retry used `VACUUM INTO` against the same live database:

```bash
sqlite3 "$db" ".timeout 30000" "VACUUM INTO '$backup'"
```

It ran from 01:27:55 to 01:30:17 (2 minutes 22 seconds) and wrote a compacted 3,506,343,936-byte snapshot. A `sqlite3 -readonly` read of the snapshot returned 151 `usage_windows`, 2,004,210 `requests` and 14 `accounts` rows, and the deploy went ahead.

`docs/deployment.md` shipped the same `.backup` command in its daily `backup.sh`, so anyone following it on a busy server would hit the same stall.

## Guidance

Take every snapshot of a running better-ccflare database with `VACUUM INTO`:

```bash
sqlite3 "$DB" ".timeout 30000" "VACUUM INTO '$TARGET.partial'" && mv "$TARGET.partial" "$TARGET"
```

- Give each run a new, dated target. `VACUUM INTO` refuses an existing file (`Error: stepping, output file already exists`) rather than overwriting it, so delete a failed run's partial before retrying.
- Write to a temporary name and rename only on success. SQLite documents that a `VACUUM INTO` interrupted by a crash or power loss can leave an incomplete, corrupt output file, and a run killed partway leaves its unfinished output behind.
- Read the snapshot back before relying on it, for example with `sqlite3 -readonly` row counts of `usage_windows`, `requests` and `accounts`.
- Keep `.timeout 30000`, so a briefly locked database makes the command wait instead of failing at once.
- Copy the files directly only when the server is stopped, and copy any `-wal` and `-shm` files with the `.db`.

Do not run the sqlite3 `.backup` command, or a `sqlite3_backup_step` loop, against a database the server is writing.

## Why This Matters

The two commands handle concurrent writes differently.

- The online backup API copies the database in steps. SQLite documents that when another connection modifies the source, "the backup will be automatically restarted by the next call to sqlite3_backup_step()". The proxy writes on every request, so a multi-gigabyte backup that needs many steps can restart again and again without finishing. The run above is consistent with that behaviour; its restarts were not counted.
- A restarted backup copies from the first page again, into a file that an earlier pass already grew. The target's size therefore says nothing about progress. Here it was within 17 MB of the source size while still running.
- `VACUUM INTO` reads the whole database inside one read transaction, and SQLite documents its output as "a consistent snapshot of the original database". In WAL mode that read transaction neither blocks the proxy's writes nor restarts when they land, and the snapshot includes committed changes still held in the `-wal` file.

The cost is that the open read transaction holds back WAL checkpoints until it ends. SQLite's WAL documentation says a checkpoint cannot reset the WAL while another connection has a read transaction open, so the `-wal` file can grow for the length of the run. That growth was not measured here; at 2 minutes 22 seconds the window is short.

The output also differs from the source in two ways: it is compacted (3.5 GB from 4.5 GB here), and it is written in rollback-journal mode. When the server opens a restored copy, `configureSqlite` in `packages/database/src/database-operations.ts` switches it back to WAL unless `walMode` is disabled.

## When to Apply

- Before any deploy or migration that touches the production database, and in any backup cron job.
- When a `.backup` against a live database has run far longer than one read of the file should take: terminate it, delete the partial file and its `-journal`, and rerun with `VACUUM INTO`.
- Not for a database that may be corrupt. `VACUUM INTO` reads every table and may stop at a damaged page; stop the server and copy the files instead.

## Examples

Before, in the `backup.sh` script in `docs/deployment.md`:

```bash
sqlite3 "$CONFIG_DIR/better-ccflare.db" ".backup $BACKUP_DIR/better-ccflare.db"
```

After:

```bash
SNAPSHOT="$BACKUP_DIR/better-ccflare.db"
if ! sqlite3 "$CONFIG_DIR/better-ccflare.db" ".timeout 30000" "VACUUM INTO '$SNAPSHOT.partial'"; then
    rm -f "$SNAPSHOT.partial"
    exit 1
fi
mv "$SNAPSHOT.partial" "$SNAPSHOT"
```

The application code already works this way. `runMigrations` in `packages/database/src/migrations.ts` takes its pre-migration backup with `VACUUM INTO` into a `.partial` file and renames it on success, and `rebuild-windows --dry-run` clones the live database with `VACUUM INTO` (`packages/cli-commands/src/commands/rebuild-windows.ts`). The operator docs were what still showed `.backup` or a plain `cp` for a running database.

## Related

- `docs/deployment.md` (Backup Procedures), `docs/database.md` (Backup Strategies), `docs/troubleshooting.md` and `docs/migration-v2-to-v3.md`: their live-database backup commands now use `VACUUM INTO`.
- Issue #541 (counting Codex CLI, Desktop and cloud usage in Window Value): its production deploy is the one whose pre-deploy snapshot hit this.
- SQLite documentation: the online backup API (`https://sqlite.org/backup.html`, `https://sqlite.org/c3ref/backup_finish.html`), `VACUUM INTO` (`https://sqlite.org/lang_vacuum.html`) and WAL checkpoints (`https://sqlite.org/wal.html`).
