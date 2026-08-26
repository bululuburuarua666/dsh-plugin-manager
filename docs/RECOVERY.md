# Recovery Guide

What to do when a lifecycle operation reports a failure code. Bilingual:
this is the English reference; see [RECOVERY.zh.md](./RECOVERY.zh.md).

## Where state lives

| Path (under `$DSH_HOME`) | Meaning |
|---|---|
| `profiles/<name>/cordis.patch.yml` | the managed toggle rows live in a marked block at the end |
| `profiles/<name>/plugin-lifecycle-backups/<name>/` or `dsh-plugin-manager-backups/<name>/` | pre-mutation images with a SHA-256 manifest |
| `profiles/<name>/dsh-plugin-manager-pending-removals.json` | uninstall records awaiting a restart |

## Error-code routing

| Code | Meaning | Action |
|---|---|---|
| `TIMEOUT` | the loader never reflected the toggle | the patch was rolled back; retry, or check the Host's patch watcher |
| `INVALID_PATCH` / `MANAGED_BLOCK_INVALID` | the patch file around the block is malformed | the file was NOT modified; fix the YAML by hand or restore a backup |
| `PACKAGE_MANAGER_FAILED` | pnpm exited non-zero | everything was rolled back; run `pnpm install` in the profile dir to be sure |
| `POSTCONDITION_FAILED` | a post-uninstall check found leftovers | rolled back; the backup dir holds the before-images |
| `ROLLBACK_INCOMPLETE` | the restore write itself failed | **manual recovery needed** — see below |

## Manual recovery from `ROLLBACK_INCOMPLETE`

1. Stop the DSH process for that profile.
2. Open `<backup-root>/<operationId>/` — it contains every file the
   operation touched, plus `manifest.json` with SHA-256 digests of the
   before-images.
3. Verify a file's current digest only matches the manifest's *after*
   digest (i.e. the operation's write survived) before restoring its
   before-image; if it matches neither, someone else edited it — restore
   by judgment, not blindly.
4. After restoring, delete the operation's `pending-removals.json` entry
   if present, and boot the profile.

## Pending-removal records

A record survives until its package is absent from the manifest **and** its
entries are absent from the loader tree. On every startup the plugin prunes
settled records and their managed rows, idempotently. If a record seems
stuck: check whether the dependency came back (re-added), or whether an
entry with the same id exists.

## Guarantees

- The plugin never deletes recovery data on uninstall (only its own
  package).
- External edits between an operation's write and its rollback are never
  overwritten (hash-guarded restores).
