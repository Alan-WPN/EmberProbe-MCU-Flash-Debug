---
name: mcu-variables
description: Read, monitor, trend, export, or explicitly modify MCU variables resolved from ELF and DWARF data. Use for live values, structs, arrays, runtime trends, CSV history, and requested variable tuning.
---

# MCU Variables

Choose the narrowest operation that satisfies the request:

- For listing, reading, sampling, trending, chart integration, or CSV export, read [references/reading.md](references/reading.md) and use `scripts/read.js`.
- Only when the user explicitly asks to set, tune, override, or otherwise modify a variable, read [references/writing.md](references/writing.md) and use `scripts/write.js`.

Never turn a read or monitoring request into a write. A write request starts planning but is not itself approval to execute the returned write plan. Preserve exact 64-bit `valueText` fields when reporting values, and base failures on the structured stderr diagnostic instead of guessing a probe or service cause.
