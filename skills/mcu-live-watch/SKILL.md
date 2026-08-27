---
name: mcu-live-watch
description: Read, trend, or export CSV history for MCU variables through EmberProbe. Handles scalars plus struct members and array elements via DWARF paths. Use when the user asks an agent to inspect, monitor, sample, compare, export, or report live embedded variable values while firmware is running.
---

# MCU Live Watch

Use `scripts/read-live.js` from this skill directory.

## Fast path: read current values

Pass the variable names directly:

```bash
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables Tick,sinx
```

Do not search source files for their declarations first, do not ask the user to start sampling, and do not add type suffixes unless the user explicitly requests a reinterpretation. EmberProbe reads the latest ELF and DWARF information, resolves a uniquely matching name case-insensitively, and infers `u8/i8/u16/i16/u32/i32/f32/u64/i64/f64`.

If live sampling is already active, EmberProbe reuses that connection. If the workspace Cortex-Debug session is paused, it reads through that session's DAP memory API without opening a competing probe; report `source: debug-session`. Otherwise, with no debug session, it starts the configured probe, reads once, and closes it immediately. A running debug target returns `PROBE_BUSY`; never pause it implicitly. Report the returned values, resolved names, types, and whether `source` is `active-sampling`, `debug-session`, or `temporary-probe`.

Only use `--list` if EmberProbe reports that a name is missing or ambiguous:

```bash
node <skill-dir>/scripts/read-live.js --workspace <workspace> --list
```

## Struct members and array elements

When firmware is built with DWARF debug info (Debug build, not stripped), EmberProbe
expands structs, unions, and arrays. Read individual members or elements using path syntax
in `--variables` (no type suffix; the type is inferred from DWARF):

```bash
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables sensor.x,sensor.y
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables buf[0],buf[1:5]
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables buf[*]
```

- `sensor.x` — a single struct/union member (supports nesting, e.g. `sensor.pos.y`).
- `buf[0]` — one array element. A single member/element is returned like a scalar
  (`value`, `type`, `address`), so it works with `--trend`.
- `buf[1:5]` — a half-open range (indices 1..4). `buf[*]` — the whole array.
- The whole variable name (e.g. `sensor` or `buf`) returns a `tree` (nested members /
  elements). Trees are for reporting, not `--trend`.

These paths require the extension bridge (the fast path above); they are not available with
`--elf`/`--port` direct reads.

## Add variables to EmberProbe

```bash
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables counter --add-to sidebar
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables temperature --add-to chart
```

`--add-to` accepts `sidebar`, `chart`, or `both`. Adding does not start sampling. Combine it with `--read`, `--count`, or `--trend` only when the user also asks to read immediately. When multiple chart panels are open, `chart` targets the most recently focused panel. With no chart open, it updates the persisted chart #1 list.

Without an explicit type suffix, `--add-to` lets the extension resolve the type from DWARF exactly like a normal read. Do not infer a type from symbol width: a 4-byte symbol may be `f32`, and an 8-byte symbol may be `f64`. Use a suffix such as `g_f32:f32` only when the user explicitly asks to reinterpret the symbol.

## Export chart history as CSV

Export the actual history buffer from the most recently focused chart panel:

```bash
node <skill-dir>/scripts/read-live.js --workspace <workspace> --export-csv --variables counter,temperature --last 30 --output exports/live.csv
```

- Omit `--variables` to select every series with buffered data, including hidden curves.
- Use `--panel 2` to target a specific chart slot instead of the focused panel.
- Prefer `--last <seconds>` for relative ranges. For absolute ranges, use complete ISO 8601 UTC timestamps ending in `Z`, ideally copied from sample/CSV timestamps (for example `2026-08-24T12:42:00.000Z`). The default end is the command invocation time; omitting the start selects the whole buffer.
- Bare `HH:MM[:SS]` is supported only as local wall-clock input and is resolved in the machine running the Skill, not as UTC. Do not derive a bare clock from a UTC timestamp. On failure, inspect `details.requestedRange.resolvedUtc`, `localTimeZone`, and `localUtcOffset` before retrying.
- With `--output`, write the RFC 4180 CSV file and return metadata. Without it, return the CSV text in the JSON result so the agent can inspect or transform it without creating a file.
- CSV values prefer exact `valueText`, matching the chart export dialog. An open chart panel with buffered samples is required; this command does not start a new sampling run.

## Trends

For a trend, use `--trend`; it defaults to 10 samples and reports rising, falling, stable, or volatile:

```bash
node <skill-dir>/scripts/read-live.js --workspace <workspace> --variables counter --trend --interval 200
```

Do not ask the user to start sampling. If sidebar/chart sampling is active, EmberProbe reuses that connection without changing its lifecycle. Otherwise EmberProbe starts an Agent-owned temporary sampling session, mirrors its startup/progress/stop state to the sidebar and chart, and releases the probe automatically when the requested samples are complete. The user may also stop that temporary session from either UI.

The trend command emits one compact summary object containing the latest values and rising, falling, stable, or volatile analysis. Do not request raw samples unless the user specifically needs them.

For `u64` and `i64`, `value` is an approximate JavaScript Number used for trend analysis and `valueText` is the exact decimal value. Prefer `valueText` when reporting the current value. Non-finite `f64` values similarly use `valueText` (`NaN`, `Infinity`, or `-Infinity`). Composite scalar leaves follow the same rule.

## Failure diagnostics

On failure, parse the single JSON object written to stderr. It has `type: "diagnostic"` and an `error` object containing `code`, `category`, `stage`, `likelyCause`, `retryable`, `suggestedActions`, and optional `details.openocdTail`.

Base the response on that diagnostic. In particular, distinguish `PROBE_NOT_FOUND`, `TARGET_NOT_CONNECTED`, `TARGET_UNPOWERED`, `PROBE_BUSY`, `TCL_PORT_IN_USE`, configuration/ELF errors, and Bridge errors. Never infer that “the active Tcl service is not running” merely because a read failed, and never quote an older instruction that asks the user to start sampling. Temporary sampling is EmberProbe's responsibility.

When you read a whole struct or array, EmberProbe expands DWARF members, offsets, dimensions, and elements into a `tree`. This includes `volatile`/typedef wrapped composites and ELF `SHF_COMPRESSED` or GNU `.zdebug_*` DWARF sections. Report that tree concisely. If DWARF layout is genuinely unavailable (stripped or non-Debug build), a composite variable cannot be expanded; say so and suggest a Debug build. Parse the JSON Lines output and report results concisely.
