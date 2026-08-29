"use strict";
const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

const SUBCOMMANDS = new Set(["start", "status", "stop", "export", "delete"]);
const VALUE_OPTIONS = new Set(["--workspace", "--variables", "--interval-ms", "--id", "--out", "--from-ms", "--to-ms"]);
const BOOLEAN_OPTIONS = new Set(["--purge", "--confirm-purge", "--confirm"]);
const DEFAULT_TIMEOUT_MS = 20000;
// 导出可能流式处理超大录制（GiB 级），给足桥接超时；status/stop/delete/start 用默认值
const EXPORT_TIMEOUT_MS = 1800000;

function args(argv) {
  const out = { command: null, flags: {} };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      if (out.command) throw new Error(`Unexpected argument: ${key}`);
      if (!SUBCOMMANDS.has(key)) throw new Error(`Unknown command: ${key}`);
      out.command = key;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(key)) out.flags[key.slice(2)] = true;
    else if (VALUE_OPTIONS.has(key)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
      out.flags[key.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${key}`);
  }
  if (!out.command) throw new Error(`Choose one command: ${[...SUBCOMMANDS].join(", ")}`);
  return out;
}

function parseVariables(value) {
  const names = String(value || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) throw new Error("Pass --variables name[,name...]");
  return names;
}

function parseMs(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number of milliseconds`);
  return Math.floor(parsed);
}

function optionalMs(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  return parseMs(value, name);
}

// 输出路径必须是工作区内的安全相对路径：脚本侧预校验拒绝绝对路径与 `..`；
// 工作区边界与符号链接逃逸由扩展侧 outputPathValidator 兜底。
function outPathError(message) {
  return Object.assign(new Error(message), { code: "EXPORT_PATH_INVALID" });
}

function validateRelativeOut(value) {
  const text = String(value || "").trim();
  if (!text) throw outPathError("Pass --out <workspace-relative.csv>");
  if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(text)) throw outPathError("--out must be a workspace-relative path, not an absolute path");
  const segments = text.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) throw outPathError('--out must not contain ".."');
  const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
  if (!normalized || normalized === ".") throw outPathError("--out must name a CSV file inside the workspace");
  return normalized;
}

function request(opt) {
  const flags = opt.flags || {};
  if (opt.command === "start") {
    return {
      method: "recording.start",
      params: {
        names: parseVariables(flags.variables),
        intervalMs: optionalMs(flags["interval-ms"], "--interval-ms")
      },
      timeoutMs: 60000
    };
  }
  if (opt.command === "status") return { method: "recording.status", params: {} };
  if (opt.command === "stop") return { method: "recording.stop", params: {} };
  if (opt.command === "export") {
    if (!flags.id) throw new Error("Pass --id <recordingId> (see the recording.status output)");
    if (!flags.out) throw new Error("Pass --out <workspace-relative.csv>");
    const purge = flags.purge === true;
    if (purge && flags["confirm-purge"] !== true) {
      const error = new Error("--purge requires --confirm-purge; confirm with the user that unselected data will be discarded");
      error.code = "CONFIRMATION_REQUIRED";
      throw error;
    }
    return {
      method: "recording.export",
      params: {
        recordingId: flags.id,
        variables: flags.variables === undefined ? undefined : parseVariables(flags.variables),
        fromMs: optionalMs(flags["from-ms"], "--from-ms"),
        toMs: optionalMs(flags["to-ms"], "--to-ms"),
        outputPath: validateRelativeOut(flags.out),
        purgeAfterSuccess: purge,
        confirmPurge: flags["confirm-purge"] === true
      },
      timeoutMs: EXPORT_TIMEOUT_MS
    };
  }
  // delete：缺 --confirm 时 confirmed=false，桥接层 recordingService 报 CONFIRMATION_REQUIRED
  if (!flags.id) throw new Error("Pass --id <recordingId>");
  return {
    method: "recording.delete",
    params: { recordingId: flags.id, confirmed: flags.confirm === true }
  };
}

async function main() {
  const opt = args(process.argv.slice(2));
  const operation = request(opt);
  const workspace = opt.flags.workspace || process.cwd();
  const result = await call(workspace, operation.method, operation.params, operation.timeoutMs || DEFAULT_TIMEOUT_MS);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const operation = (process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]) || "recording");
    writeDiagnostic(error, { operation });
    process.exitCode = 1;
  });
}

module.exports = { args, request, parseVariables, parseMs, optionalMs, validateRelativeOut, SUBCOMMANDS };
