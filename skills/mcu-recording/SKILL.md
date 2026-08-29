---
name: mcu-recording
description: Start, inspect, stop, export, or delete long-running MCU variable recordings through EmberProbe. Streams recorded history to a CSV file inside the workspace without loading it into memory. Use when the user asks an agent to record variables for a long time, check recording status or used space, export a recording to CSV, or delete a recording after explicit confirmation.
---

# MCU Recording

Use `scripts/record.js` from this skill directory. Every command returns a single JSON metadata
object (status, rows, bytes, path) on stdout; it never contains CSV content or sample values.
On failure, a `type: "diagnostic"` JSON object with `error.code` is written to stderr.

## Commands

### Start a recording

```bash
node <skill-dir>/scripts/record.js --workspace <workspace> start --variables Tick,sensor.x --interval-ms 100
```

- `--variables` (required): comma-separated variable names; member paths like `sensor.x` are
  expanded by EmberProbe from DWARF.
- `--interval-ms` (optional): sampling interval in milliseconds; defaults to the current EmberProbe
  sampling interval.
- Returns the session metadata (`recordingId`, `status`, `fixedVariables`, `quota`, ...). Only one
  active recording per workspace: `RECORDING_ACTIVE` means stop or export the existing session first.

### Check status

```bash
node <skill-dir>/scripts/record.js --workspace <workspace> status
```

Returns the active or most recent session metadata: `status` (`recording`, `completed`,
`stopped-quota`, `stopped-error`, `interrupted`, `paused-config`), `rows`, `bytes`, `gaps`,
`retries`, and quota usage. Report used space and row count when the user asks about recording
progress. Use `recording.list` semantics via repeated `status` calls only when needed; the UI
"Recordings" view lists all sessions.

### Stop a recording

```bash
node <skill-dir>/scripts/record.js --workspace <workspace> stop
```

Idempotent; safe to call again. Stopped sessions stay on disk until exported and deleted.

### Export a recording to CSV

```bash
node <skill-dir>/scripts/record.js --workspace <workspace> export --id <recordingId> --variables Tick --out exports/run1.csv
node <skill-dir>/scripts/record.js --workspace <workspace> export --id <recordingId> --from-ms 1730000000000 --to-ms 1730000600000 --out exports/window.csv
```

- `--id` (required): `recordingId` from `status`.
- `--variables` (optional): comma-separated subset; omit for all recorded variables.
- `--from-ms` / `--to-ms` (optional): UTC millisecond epoch bounds; omit either end for unbounded.
- `--out` (required): a safe relative path inside the workspace (for example `exports/run1.csv`).
  Absolute paths and any `..` segment are rejected. **Always report the relative path you are about
  to write to the user before running the export.** The result is streamed to
  `<workspace>/<out>` with the same header/time format as the chart CSV export.
- `--purge` (optional): delete the whole internal recording session after a successful export.
  Requires `--confirm-purge` in the same command, and requires asking the user first: repeat that
  **data outside the selected variables and time range will be permanently discarded, and the whole
  internal session is deleted once the export succeeds**. Never pass `--purge` on your own
  initiative; exporting an active session never purges (`RECORDING_ACTIVE`).
- The command streams and may take a while for large recordings; the result metadata reports
  `rows`, `bytes`, `outputPath`, and `purged`.

### Delete a recording

```bash
node <skill-dir>/scripts/record.js --workspace <workspace> delete --id <recordingId> --confirm
```

Destructive and irreversible. `--confirm` is mandatory; without it the bridge rejects the call with
`CONFIRMATION_REQUIRED`. Ask the user and state that the recorded data will be permanently
discarded (including anything not yet exported). An active session must be stopped first
(`RECORDING_ACTIVE` otherwise).

## Notes

- The Agent Bridge transfers control parameters and metadata only; no CSV body ever crosses the
  bridge. Read the exported file from the workspace path if you need its content.
- Prefer exporting to a dedicated folder (for example `exports/`) and tell the user where the CSV
  was written together with its row count and size.
- Common error codes: `RECORDING_ACTIVE`, `CONFIRMATION_REQUIRED`, `EXPORT_PATH_INVALID`,
  `EXPORT_VARIABLE_NOT_FOUND`, `EXPORT_CANCELLED`, `EXPORT_FAILED`, `RECORDING_NOT_FOUND`,
  `BRIDGE_UNAVAILABLE`. Surface the code and message instead of retrying destructive steps.
