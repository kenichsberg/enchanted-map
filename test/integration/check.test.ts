import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIXTURE } from "../helpers.ts";

const exec = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, "../../src/cli.ts");

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-check-"));
  cpSync(FIXTURE, dir, { recursive: true });
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@e.com"],
    ["config", "user.name", "T"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init"],
  ]) {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

async function cli(root: string, ...args: string[]) {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ["--experimental-strip-types", CLI, ...args, "--root", root],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("check exits zero when the map is current", { timeout: 300_000 }, async () => {
  const root = repo();
  await cli(root, "declare", "login", "app.py", "login");
  await cli(root, "analyze", "login");
  const res = await cli(root, "check");
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^ok\s+login/m);
});

test("check exits non-zero and lists stale entries when drifted", { timeout: 300_000 }, async () => {
  const root = repo();
  await cli(root, "declare", "login", "app.py", "login");
  await cli(root, "analyze", "login");

  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      "def audit(kind: str, user: str) -> None:\n",
      "def audit(kind: str, user: str) -> None:\n    _drift = 1\n",
    ),
  );

  const res = await cli(root, "check");
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stdout, /STALE\s+login/);
  assert.match(res.stdout, /node changed/);
});

test("check never modifies a stored flow file", { timeout: 300_000 }, async () => {
  const root = repo();
  await cli(root, "declare", "login", "app.py", "login");
  await cli(root, "analyze", "login");
  const flowFile = path.join(root, ".enchanted", "flows", "login.yaml");
  const before = readFileSync(flowFile);

  const appPath = path.join(root, "app.py");
  writeFileSync(appPath, readFileSync(appPath, "utf8").replace("if mfa:", "if mfa and user:"));

  await cli(root, "check");
  assert.ok(readFileSync(flowFile).equals(before), "check wrote nothing");
});

test("check runs headless and emits machine-readable output", { timeout: 300_000 }, async () => {
  const root = repo();
  await cli(root, "declare", "broadcast", "app.py", "broadcast");
  await cli(root, "analyze", "broadcast");
  const res = await cli(root, "check", "--json");
  assert.equal(res.code, 0);
  const parsed = JSON.parse(res.stdout) as Array<{ flow: string; stale: boolean }>;
  assert.equal(parsed[0]?.flow, "broadcast");
  assert.equal(parsed[0]?.stale, false);
});

test("an unaffected flow stays clean while another drifts", { timeout: 300_000 }, async () => {
  const root = repo();
  await cli(root, "declare", "login", "app.py", "login");
  await cli(root, "declare", "countdown", "app.py", "countdown");
  await cli(root, "analyze", "login");
  await cli(root, "analyze", "countdown");

  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      "def audit(kind: str, user: str) -> None:\n",
      "def audit(kind: str, user: str) -> None:\n    _drift = 1\n",
    ),
  );

  const res = await cli(root, "check");
  assert.equal(res.code, 1);
  assert.match(res.stdout, /STALE\s+login/);
  assert.match(res.stdout, /^ok\s+countdown/m, "countdown does not reach audit, so it is unaffected");
});

test("committed flow files contain no machine-specific paths", { timeout: 300_000 }, async () => {
  const root = repo();
  await cli(root, "declare", "login", "app.py", "login");
  await cli(root, "analyze", "login");
  const text = readFileSync(path.join(root, ".enchanted", "flows", "login.yaml"), "utf8");
  assert.ok(!text.includes(process.env["HOME"] ?? "\u0000"), "no home directory in the file");
  assert.ok(!text.includes("node_modules/"), "no node_modules path in the file");
  assert.match(text, /<ext>\//, "external symbols use a portable label");
});
