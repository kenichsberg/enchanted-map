import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { readFlow, writeFlow, flowPath } from "../../src/flow/store.ts";
import { depHashes } from "../../src/flow/model.ts";
import { computeStaleness } from "../../src/flow/staleness.ts";
import { FIXTURE } from "../helpers.ts";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-ord-"));
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

const LOGIN = { name: "login", file: "app.py", symbol: "login" };

test("the ordinal does not participate in the edge hash", () => {
  // Same call, same guards, same nesting -- only the position differs.
  const a = depHashes.edge('audit("login", user)', [], "call", null);
  const b = depHashes.edge('audit("login", user)', [], "call", null);
  assert.equal(a, b);

  // …while the way the call is reached does participate.
  assert.notEqual(
    depHashes.edge("notify(x)", [], "call", null),
    depHashes.edge("notify(x)", [], "argument", "some-site"),
    "kind is semantic",
  );
  assert.notEqual(
    depHashes.edge("notify(x)", [], "argument", "site-a"),
    depHashes.edge("notify(x)", [], "argument", "site-b"),
    "which call an argument feeds is semantic",
  );
});

test("inserting a call renumbers ordinals without marking later edges stale", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, LOGIN);
  const svc = new FlowService(root);
  const before = await svc.refresh("login");

  // Insert a brand-new call at the very top of login's body. Everything below
  // shifts by one line and by one ordinal.
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      'def login(user: str, mfa: bool) -> None:\n    # unguarded call\n    audit("login", user)',
      'def login(user: str, mfa: bool) -> None:\n    combine("a", "b")\n    # unguarded call\n    audit("login", user)',
    ),
  );

  const after = await svc.analyze("login");

  // The ordinals did shift…
  const notifyBefore = before.edges.find(
    (e) => e.from === before.root && e.to.endsWith("#notify"),
  );
  const notifyAfter = after.edges.find(
    (e) => e.from === after.root && e.to.endsWith("#notify"),
  );
  assert.ok(notifyBefore && notifyAfter);
  assert.equal(
    notifyAfter.ordinal,
    notifyBefore.ordinal + 1,
    "the inserted call pushed later calls down by one",
  );

  // …but the edge is not stale, because the ordinal is not hashed.
  assert.equal(
    notifyAfter.depHash,
    notifyBefore.depHash,
    "an inserted call above must not invalidate the edges below it",
  );

  const report = computeStaleness(root, before, after);
  const staleIds = new Set(report.entries.filter((e) => e.kind === "edge").map((e) => e.affects));
  assert.ok(
    !staleIds.has(notifyBefore.id),
    `the notify edge was wrongly marked stale: ${JSON.stringify([...staleIds])}`,
  );
  assert.ok(
    !staleIds.has(
      before.edges.find((e) => e.from === before.root && e.to.endsWith("#create_session"))!.id,
    ),
    "nor was create_session",
  );
});

test("moving a call into an argument position does change its hash", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, LOGIN);
  const svc = new FlowService(root);
  const before = await svc.refresh("login");

  // `audit("login", user)` becomes an argument of combine(...): same callee,
  // same caller, but reached a genuinely different way.
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      '    audit("login", user)\n    if mfa:',
      '    combine(audit("login", user), "x")\n    if mfa:',
    ),
  );

  const after = await svc.analyze("login");
  // create_session also calls audit, so scope to calls made by the entry point.
  const auditBefore = before.edges.find(
    (e) => e.from === before.root && e.to.endsWith("#audit"),
  );
  const auditAfter = after.edges.find(
    (e) => e.from === after.root && e.to.endsWith("#audit"),
  );
  assert.ok(auditBefore && auditAfter);
  assert.equal(auditBefore.kind, "call");
  assert.equal(auditAfter.kind, "argument", "it is now an argument of combine");
  assert.notEqual(
    auditAfter.depHash,
    auditBefore.depHash,
    "a real change in how the call is reached must mark it stale",
  );
});

test("edges persist in source order per caller", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, LOGIN);
  const flow = await new FlowService(root).refresh("login");
  const fromRoot = flow.edges.filter((e) => e.from === flow.root);
  const ordinals = fromRoot.map((e) => e.ordinal);
  assert.deepEqual([...ordinals].sort((a, b) => a - b), ordinals, "stored in ascending order");

  // And a round trip is still byte-identical.
  const first = readFileSync(flowPath(root, "login"));
  writeFlow(root, readFlow(root, "login")!);
  assert.ok(first.equals(readFileSync(flowPath(root, "login"))));
});

test("a flow stored before this change parses, and re-analysis restores fidelity", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, LOGIN);
  const svc = new FlowService(root);
  const flow = await svc.refresh("login");

  // Add curation, then strip the new fields to simulate an older file.
  flow.judgments.labels[flow.root] = "the login entry point";
  writeFlow(root, flow);

  const file = flowPath(root, "login");
  const raw = YAML.parse(readFileSync(file, "utf8")) as { edges: Record<string, unknown>[] };
  for (const e of raw.edges) {
    delete e["ordinal"];
    delete e["kind"];
    delete e["enclosingSite"];
  }
  writeFileSync(file, YAML.stringify(raw, { lineWidth: 0 }), "utf8");

  const legacy = readFlow(root, "login");
  assert.ok(legacy, "the older file still parses");
  assert.equal(legacy.edges[0]?.kind, "call", "missing fields are defaulted, not fatal");
  assert.equal(legacy.judgments.labels[flow.root], "the login entry point");

  // Re-analysis restores the real values and keeps the curation.
  const fresh = await svc.refresh("login");
  assert.ok(fresh.edges.some((e) => e.kind === "argument"), "nesting is recovered");
  assert.equal(
    fresh.judgments.labels[flow.root],
    "the login entry point",
    "curation survives re-analysis",
  );
});
