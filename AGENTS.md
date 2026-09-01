# Repository Guidelines

## Project Structure & Module Organization

EmberProbe is a CommonJS VS Code extension targeting Node.js 20 and VS Code 1.85+. Core extension code lives in `src/`; orchestration and hardware-facing logic is split into `src/services/`, while sidebar and live-watch browser code is under `src/webview/`. Bundled agent capabilities live in `skills/<skill-name>/` with a `SKILL.md`, scripts, and agent metadata. Put automated tests in `test/`, extension-host smoke tests in `test/e2e/`, and opt-in hardware tests in `test/hil/`. Release utilities belong in `scripts/`; icons and the bundled Windows OpenOCD archive live in `media/` and `resources/`. `dist/`, `coverage/`, and `.vscode-test/` are generated and must not be edited or committed.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependency set used by CI.
- `npm run check`: syntax-check source files and run the full normal test suite.
- `npm run quality`: run ESLint, Prettier checks, JavaScript type-checking, and coverage gates.
- `npm run bundle`: build `dist/extension.js` and webview assets with esbuild.
- `npm run test:e2e`: bundle and run the VS Code Extension Host smoke test.
- `npm run package`: create a VSIX in `dist/`.
- `npm run test:hil`: run destructive real-board tests; follow `test/hil/README.md` and use dedicated hardware.

## Coding Style & Naming Conventions

Use ES2022 CommonJS (`require`/`module.exports`), four-space indentation, double quotes, semicolons, LF endings, and a 120-character print width. Prettier and ESLint are authoritative; run `npm run quality` before submitting. Use `camelCase` for functions and variables, `PascalCase` for classes, and descriptive kebab-case skill directories such as `skills/mcu-flash/`. Keep hardware operations behind services and preserve existing validation and authorization boundaries.

## Testing Guidelines

Tests are executable Node.js files using built-in `assert`; name new files `test/<feature>.test.js`. Add focused coverage for success, failure, and input-validation paths. The c8 minimums are 80% lines/statements, 75% functions, and 65% branches. Hardware-independent tests must not require OpenOCD or a connected probe.

## Commit & Pull Request Guidelines

Follow the history's short, imperative subjects: `Add Cortex-Debug integration` or `Fix macOS flash skill CI path check`. Reserve `Release EmberProbe vX.Y.Z` for releases. Pull requests should explain behavior and risk, link relevant issues, note tested platforms/hardware, and include screenshots for webview changes. Confirm `npm run check`, `npm run quality`, `npm run bundle`, and relevant e2e tests pass.

## Release Process

Releases are tag-driven: pushing a stable `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which reruns the gates, builds the VSIX, and publishes the GitHub Release. Do not run `npm run package` locally for a release — CI builds and uploads the artifact. To cut a release:

1. Land the changes on `master`, then document user-facing changes under `## [Unreleased]` in `CHANGELOG.md` (the section must be non-empty).
2. Run `npm run release:prepare -- <version> --date YYYY-MM-DD`; it syncs `package.json`, `package-lock.json`, `README.md`, `README_EN.md`, and the CHANGELOG heading. Confirm with `node scripts/validate-release.js v<version>`.
3. Run `npm run check` and `npm run quality`; fix any failures before tagging.
4. Commit exactly those five files as `Release EmberProbe v<version>`, then create the annotated tag with `git tag -a v<version> -m "EmberProbe v<version>"`.
5. Push both: `git push origin master && git push origin v<version>`, then watch the run with `gh run watch`.
6. After the workflow publishes, replace the generated notes with a concise bilingual summary that mirrors the previous release (`gh release view` to read it): numbered Chinese sections `新增`/`优化`/`修复` followed by English `Added`/`Improved`/`Fixed`, one short line each, via `gh release edit v<version> --notes-file <file>`.

Tags must be stable `vX.Y.Z` (no prereleases) and must match every version reference or validation fails; never re-point a published tag. If the workflow fails after tagging, retry it with `gh workflow run release.yml -f tag=v<version>`. Full details: `docs/RELEASING.md`.
