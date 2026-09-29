import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowService } from "../../src/flow/service.ts";
import { flowView, diffView } from "../../src/views/index.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { FIXTURE } from "../helpers.ts";

function repo(from = FIXTURE): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-e2e-"));
  cpSync(from, dir, { recursive: true });
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

test("login reaches notify and create_session under the right guards", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const view = flowView(await new FlowService(root).analyze("login"));
  const label = (id: string) => view.nodes.find((n) => n.id === id)?.label ?? id;

  const toNotify = view.edges.find((e) => label(e.to) === "notify");
  assert.ok(toNotify, "login calls notify");
  assert.equal(toNotify.conditionLabel, "mfa", "guarded by the positive arm");

  const toSession = view.edges.find((e) => label(e.to) === "create_session");
  assert.ok(toSession, "login calls create_session");
  assert.equal(toSession.conditionLabel, "!mfa", "guarded by the negative arm");

  const unguarded = view.edges.filter((e) => label(e.to) === "audit" && e.from === view.root);
  assert.equal(unguarded.length, 2, "two distinct calls to audit");
  for (const e of unguarded) {
    assert.equal(e.conditionLabel, "", "both audit calls are unguarded");
  }

  // No node represents a branch; guards live only on edges.
  assert.ok(
    view.nodes.every((n) => !/if_|else_|for_/.test(n.id)),
    "branching added no nodes",
  );
});

test("the dispatch hole records SMSSender.send among its candidates", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "broadcast", file: "app.py", symbol: "broadcast" });
  const flow = await new FlowService(root).analyze("broadcast");

  assert.equal(flow.holes.length, 1, "one unresolved dispatch");
  const hole = flow.holes[0]!;
  assert.match(hole.declaredTarget, /senders\.py#Sender\.send/, hole.declaredTarget);
  assert.deepEqual(
    hole.candidates.sort(),
    ["senders.py#EmailSender.send", "senders.py#SMSSender.send"],
    "both concrete implementations are candidates",
  );

  const edge = flow.edges.find((e) => e.provenance === "declared-unresolved");
  assert.ok(edge, "the edge is retained at reduced confidence, not dropped");
});

test("full loop: declare, analyze, view, accept, change, re-check", { timeout: 300_000 }, async () => {
  const root = repo();
  const svc = new FlowService(root);

  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const stored = await svc.refresh("login");
  assert.ok(stored.nodes.length > 0);

  svc.accept("login");
  let status = await svc.status("login");
  assert.equal(status.report?.stale, false, "accepted and current");
  assert.equal(flowView(status.stored!, status.report).acceptance, "accepted");

  // Change the code the way an agent would: add a call on a new path.
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      "def create_session(user: str) -> None:\n    audit(\"session\", user)",
      "def rate_limit(user: str) -> None:\n    audit(\"limit\", user)\n\n\n" +
        "def create_session(user: str) -> None:\n    audit(\"session\", user)\n    rate_limit(user)",
    ),
  );

  status = await svc.status("login");
  assert.equal(status.report?.stale, true, "drift is detected");
  const view = flowView(status.stored!, status.report);
  assert.equal(view.acceptance, "accepted-but-drifted", "the stamp is kept, not cleared");

  const diff = diffView(status.stored!, status.current!);
  assert.ok(
    diff.newlyReachable.some((n) => n.label === "rate_limit"),
    `newly reachable: ${diff.newlyReachable.map((n) => n.label).join(",")}`,
  );

  // Some of the flow is stale; the rest is still readable.
  assert.ok(view.nodes.some((n) => n.stale));
  assert.ok(view.nodes.some((n) => !n.stale));
});

test("analyzes a real Python package from the standard library", { timeout: 600_000 }, async () => {
  // Real code, real branching, not a fixture written to pass.
  const stdlib = path.join(
    path.dirname(path.dirname(process.execPath)),
    "lib",
  );
  const candidates = [
    path.join(stdlib, "python3.13", "json"),
    "/Users/ken/.local/share/mise/installs/python/3.13.12/lib/python3.13/json",
  ];
  const source = candidates.find((c) => {
    try {
      readFileSync(path.join(c, "__init__.py"));
      return true;
    } catch {
      return false;
    }
  });
  if (!source) {
    // No stdlib source available in this environment; the other tests still cover the loop.
    return;
  }

  const root = repo(source);
  declareEntryPoint(root, { name: "dumps", file: "__init__.py", symbol: "dumps" });
  const svc = new FlowService(root);

  const started = Date.now();
  const flow = await svc.refresh("dumps");
  const elapsed = Date.now() - started;

  assert.ok(flow.nodes.length > 1, `json.dumps reaches ${flow.nodes.length} nodes`);
  assert.ok(flow.edges.length > 0);
  const internal = flow.nodes.filter((n) => !n.external);
  assert.ok(internal.length > 1, "traversal stayed inside the package and found real calls");

  // Guards were extracted from real code, not just the fixture.
  const guarded = flow.edges.filter((e) => e.conditions.length > 0);
  assert.ok(guarded.length > 0, "real code has guarded calls");

  process.stderr.write(
    `\n  [timing] json.dumps depth=${flow.maxDepth}: ${elapsed}ms, ` +
      `${flow.nodes.length} nodes (${internal.length} internal), ` +
      `${flow.edges.length} edges, ${flow.holes.length} holes, ` +
      `${guarded.length} guarded edges\n`,
  );
});
