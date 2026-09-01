---
name: mcu-flash
description: Program MCU firmware or verify on-chip Flash against the workspace ELF through OpenOCD. Use when the user asks to flash, download, program, burn, verify, compare, or confirm firmware on an attached target.
---

# MCU Flash

Choose exactly one operation from the user's request:

- To program, download, burn, or flash firmware, read [references/programming.md](references/programming.md) and use `scripts/program.js`.
- To compare existing on-chip Flash with the local ELF without programming it, read [references/verification.md](references/verification.md) and use `scripts/verify.js`.

Programming already performs OpenOCD's program-and-verify sequence. If the user asks to flash and confirm success in one request, run only the programming workflow and report its verification result; do not start a second verification session.

Both operations must complete detection first and report the selected ELF, ELF SHA-256, target, probe, and OpenOCD executable. Never guess a missing target or probe. Do not run either operation while EmberProbe is sampling, downloading, or debugging because the probe has a single owner.
