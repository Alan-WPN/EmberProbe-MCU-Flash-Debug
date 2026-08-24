---
name: mcu-download
description: Detect and download embedded MCU firmware with OpenOCD. Use when the user asks an agent to flash, program, burn, or download the current workspace ELF firmware to an attached MCU through ST-Link, J-Link, CMSIS-DAP, XDS110, or Nu-Link.
---

# MCU Download

Use the bundled `scripts/download.js` from this skill directory. Do not construct an OpenOCD shell command manually.

1. Run a preflight without `--execute` from the workspace root (Node.js 16+, any OS):

   ```bash
   node <skill-dir>/scripts/download.js --workspace <workspace>
   ```

2. Report the detected ELF, target, probe, and OpenOCD executable. If detection is incomplete, stop and ask the user to connect/select the missing item. Never guess a target configuration. Notes in the JSON output explain when a USB enumeration tool is missing (for example `lsusb` on Linux).
3. When the user explicitly asked to download or flash, rerun the same command with `--execute`.
4. Report the ELF SHA-256 fingerprint, OpenOCD's exit code, and concise result. On failure, include the actionable tail of its output.

The script first reuses EmberProbe's configured ELF, MCU target, probe, and OpenOCD executable through the Agent Bridge. Missing values fall back to workspace/USB auto-detection: newest ELF by modification time, MCU hints from `.ioc`, CMake, and linker files, and the attached debug probe (Windows PnP / `pnputil`, macOS `system_profiler`, Linux `lsusb`). Explicit `--elf`, `--target`, `--probe`, or `--openocd` values always take precedence.

Before programming, the script enables work-area backup on every configured OpenOCD target. This keeps flash algorithms fast while restoring any RAM that overlaps the target work-area. It also resolves the executable and configuration scripts to canonical paths and runs OpenOCD from its trusted scripts directory, preventing workspace files from shadowing official Tcl/config files.

OpenOCD 0.12.0 or newer is required. Preflight reports `openocdVersion`, `openocdCompatible`, and `minimumOpenocdVersion`; execution must stop when compatibility is false. On Windows, tell the user they can select EmberProbe's bundled xPack OpenOCD 0.12.0-7 from the extension's OpenOCD status card.
