import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowAnalyzer } from "../../src/flow/analyze.ts";
import { reconcile, detectFileRenames } from "../../src/flow/identity.ts";
import { computeStaleness, accept, acceptanceState, currentRevision } from "../../src/flow/staleness.ts";
import { FIXTURE } from "../helpers.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function scratchRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-stale-"));
  cpSync(FIXTURE, dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

const LOGIN = { name: "login", file: "app.py", symbol: "login" };
const analyze = (root: string) => new FlowAnalyzer(root, { maxDepth: 3 }).analyze(LOGIN);

test("an unchanged flow reports no staleness", { timeout: 240_000 }, async () => {
  const root = scratchRepo();
  const stored = await analyze(root);
  const current = await analyze(root);
  const report = computeStaleness(root, stored, current);
  assert.equal(report.stale, false, JSON.stringify(report.entries, null, 2));
  assert.deepEqual(report.entries, []);
});

test("staleness is localised to the affected entries", { timeout: 240_000 }, async () => {
  const root = scratchRepo();
  const stored = await analyze(root);

  // Change the body of exactly one function in the flow.
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      "def audit(kind: str, user: str) -> None:\n",
      "def audit(kind: str, user: str) -> None:\n    _touched = True\n",
    ),
  );

  const current = await analyze(root);
  const report = computeStaleness(root, stored, current);
  assert.ok(report.stale);

  const staleNodes = report.entries.filter((e) => e.kind === "node");
  assert.ok(staleNodes.length > 0, "at least the edited node is stale");
  // The great majority of the flow is untouched.
  assert.ok(
    staleNodes.length < stored.nodes.length,
    `only some nodes stale: ${staleNodes.length} of ${stored.nodes.length}`,
  );
  const untouched = stored.nodes.filter(
    (n) => !report.entries.some((e) => e.affects === n.id),
  );
  assert.ok(untouched.length > 0, "the remainder of the flow is still current");
});

test("git reports a file move and identity is carried across", { timeout: 240_000 }, async () => {
  const root = scratchRepo();
  const stored = await analyze(root);
  const base = currentRevision(root);
  assert.ok(base, "scratch repo has a HEAD");

  // Move senders.py into a package, preserving content.
  const pkg = path.join(root, "messaging");
  execFileSync("mkdir", ["-p", pkg]);
  renameSync(path.join(root, "senders.py"), path.join(pkg, "senders.py"));
  writeFileSync(path.join(pkg, "__init__.py"), "");
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace("from senders import", "from messaging.senders import"),
  );
  git(root, "add", "-A");

  const renames = detectFileRenames(root, base);
  assert.equal(
    renames.get("senders.py"),
    "messaging/senders.py",
    `git detected the move: ${JSON.stringify([...renames])}`,
  );

  const current = await analyze(root);
  const identity = reconcile(root, stored, current, { fromRev: base });
  const movedSymbols = [...identity.carried.entries()].filter(([from, to]) => from !== to);
  assert.ok(
    movedSymbols.length > 0,
    `symbols in the moved file kept their identity: ${JSON.stringify(movedSymbols)}`,
  );
  for (const [from, to] of movedSymbols) {
    assert.ok(from.startsWith("senders.py#"));
    assert.ok(to.startsWith("messaging/senders.py#"));
  }
});

test("a symbol renamed without a body change keeps its identity", { timeout: 240_000 }, async () => {
  const root = scratchRepo();
  const stored = await analyze(root);

  // Rename create_session -> start_session. The implementation body is untouched.
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8")
      .replace("def create_session(user: str) -> None:", "def start_session(user: str) -> None:")
      .replace("create_session(user)", "start_session(user)"),
  );

  const current = await analyze(root);
  const old = stored.nodes.find((n) => n.name === "create_session");
  const renamed = current.nodes.find((n) => n.name === "start_session");
  assert.ok(old, "the old node existed");
  assert.ok(renamed, "the renamed node exists");

  // Identity hashes the body only, so a pure rename matches exactly.
  assert.equal(old.bodyHash, renamed.bodyHash, "the implementation body is unchanged");

  const identity = reconcile(root, stored, current);
  assert.equal(
    identity.carried.get(old.id),
    renamed.id,
    "the node kept its identity across the rename",
  );
  assert.ok(!identity.invalidated.includes(old.id), "it was not invalidated");

  // It is still stale -- a changed signature is a real change -- but it is
  // reported as changed, not as a removal plus an addition.
  const report = computeStaleness(root, stored, current, { identity });
  const entries = report.entries.filter(
    (e) => e.affects === renamed.id || e.affects === old.id,
  );
  assert.deepEqual(
    entries.map((e) => e.reason),
    ["changed"],
    `expected a single 'changed' entry, got ${JSON.stringify(entries)}`,
  );
});

test("a renamed-and-edited symbol is invalidated, not matched", { timeout: 240_000 }, async () => {
  const root = scratchRepo();
  const stored = await analyze(root);
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8")
      .replace(
        "def create_session(user: str) -> None:\n    audit(\"session\", user)",
        "def start_session(user: str) -> None:\n    audit(\"session\", user)\n    _extra = 2",
      )
      .replace("create_session(user)", "start_session(user)"),
  );
  const current = await analyze(root);
  const identity = reconcile(root, stored, current);
  const old = stored.nodes.find((n) => n.name === "create_session");
  assert.ok(old);
  assert.ok(
    identity.invalidated.includes(old.id),
    "rename + edit is not approximately matched",
  );
});

test("acceptance is per flow and drifts rather than resetting", { timeout: 240_000 }, async () => {
  const root = scratchRepo();
  const stored = await analyze(root);
  assert.equal(acceptanceState(stored, null), "unaccepted");

  const rev = currentRevision(root);
  assert.ok(rev);
  const accepted = accept(stored, rev);
  assert.equal(accepted.accepted?.revision, rev);
  assert.equal(acceptanceState(accepted, computeStaleness(root, stored, stored)), "accepted");

  // Drift the code.
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      "def audit(kind: str, user: str) -> None:\n",
      "def audit(kind: str, user: str) -> None:\n    _drift = 1\n",
    ),
  );
  const current = await analyze(root);
  const report = computeStaleness(root, accepted, current);
  assert.ok(report.stale);
  assert.equal(acceptanceState(accepted, report), "accepted-but-drifted");
  assert.equal(accepted.accepted?.revision, rev, "the stamp is retained, not cleared");
});
