# Reading, trending, and exporting variables

Use `scripts/read.js` from the Skill directory.

For a current value, pass names directly. Do not search source declarations first, require pre-started sampling, or add type suffixes unless the user requests reinterpretation:

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --variables Tick,sinx
```

Use `--list` only after a missing or ambiguous name. DWARF paths support members and array selections such as `sensor.pos.y`, `buf[0]`, `buf[1:5]`, and `buf[*]`. Whole composites return a reporting tree and cannot be trended.

For trends, use `--trend`; it defaults to ten samples. EmberProbe reuses an existing compatible connection or owns and releases a temporary sampling session:

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --variables counter --trend --interval 200
```

Use `--add-to sidebar|chart|both` only when the user asks to update the EmberProbe UI. Adding does not start sampling. Export an open chart's real history with `--export-csv`; prefer `--last <seconds>` or complete ISO 8601 UTC timestamps, and keep `--output` relative to the workspace:

```bash
node <skill-dir>/scripts/read.js --workspace <workspace> --export-csv --variables counter,temperature --last 30 --output exports/live.csv
```

If an EmberProbe-managed debug target is running, reads are limited to writable allocated ELF RAM. A paused session may use DAP memory. Never pause a user-managed session implicitly. Report resolved names, inferred types, exact text values where present, source, and concise trend or composite results.

On failure, use the diagnostic's `error.code`, `likelyCause`, `suggestedActions`, and `details`. Distinguish probe absence, target connection or power, probe ownership, Tcl port, configuration/ELF, and Bridge errors.
