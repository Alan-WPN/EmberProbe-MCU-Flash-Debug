# Verifying existing Flash

Use `scripts/verify.js` from the Skill directory. This operation does not program Flash, but it temporarily halts the core while comparing and restores the original running state.

First run detection only:

```bash
node <skill-dir>/scripts/verify.js --workspace <workspace>
```

Report the selected ELF and SHA-256, target, probe, OpenOCD executable, and compatibility result. Stop if detection is incomplete or OpenOCD is older than 0.12.0. Then run:

```bash
node <skill-dir>/scripts/verify.js --workspace <workspace> --execute
```

Explicit `--elf`, `--target`, `--probe`, and `--openocd` values take precedence over automatic detection. The script disables the target work area so verification cannot overwrite RAM, resolves all launch paths canonically, and restores the prior target state.

The final JSON line contains `verified`, `elf`, `elfSha256`, and mismatch `detail`. Exit code 0 means Flash matches the ELF. Exit code 1 with `verified: false` means it differs; report the detail and offer the programming workflow, but do not program without a separate explicit request and its confirmation.
