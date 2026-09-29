import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowAnalyzer, BrokenEntryPointError } from "../../src/flow/analyze.ts";
import { writeFlow, readFlow, listFlows, flowPath, markBroken } from "../../src/flow/store.ts";
import { declareEntryPoint, loadConfig } from "../../src/flow/config.ts";
import { depHashes } from "../../src/flow/model.ts";
import { FIXTURE } from "../helpers.ts";

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-flow-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const LOGIN = { name: "login", file: "app.py", symbol: "login" };
const BROADCAST = { name: "broadcast", file: "app.py", symbol: "broadcast" };

test("declares an entry point into project config", () => {
  const root = scratch();
  declareEntryPoint(root, LOGIN);
  const config = loadConfig(root);
  assert.equal(config.entryPoints.length, 1);
  assert.deepEqual(config.entryPoints[0], LOGIN);

  declareEntryPoint(root, BROADCAST);
  assert.equal(loadConfig(root).entryPoints.length, 2);

  // Redeclaring replaces rather than duplicates.
  declareEntryPoint(root, { ...LOGIN, symbol: "login" });
  assert.equal(loadConfig(root).entryPoints.length, 2);
});

test("analyzes a flow and persists it", { timeout: 240_000 }, async () => {
  const root = scratch();
  const flow = await new FlowAnalyzer(root, { maxDepth: 3 }).analyze(LOGIN);
  assert.equal(flow.name, "login");
  assert.ok(flow.nodes.length > 0);
  assert.ok(flow.edges.length > 0);
  assert.equal(flow.accepted, null, "a fresh flow is unaccepted");
  assert.deepEqual(flow.judgments, { labels: {}, clusters: [], dispatch: {} });

  writeFlow(root, flow);
  const back = readFlow(root, "login");
  assert.ok(back);
  assert.equal(back.name, flow.name);
  assert.equal(back.nodes.length, flow.nodes.length);
  assert.equal(back.edges.length, flow.edges.length);
});

test("two flows occupy separate files", { timeout: 240_000 }, async () => {
  const root = scratch();
  const analyzer = new FlowAnalyzer(root, { maxDepth: 2 });
  writeFlow(root, await analyzer.analyze(LOGIN));
  const loginBytes = readFileSync(flowPath(root, "login"));
  writeFlow(root, await analyzer.analyze(BROADCAST));
  assert.deepEqual(listFlows(root), ["broadcast", "login"]);
  assert.ok(
    loginBytes.equals(readFileSync(flowPath(root, "login"))),
    "writing broadcast left login byte-identical",
  );
});

test("an unchanged flow round-trips byte-identically", { timeout: 240_000 }, async () => {
  const root = scratch();
  const flow = await new FlowAnalyzer(root, { maxDepth: 3 }).analyze(LOGIN);
  writeFlow(root, flow);
  const first = readFileSync(flowPath(root, "login"));
  const reloaded = readFlow(root, "login");
  assert.ok(reloaded);
  writeFlow(root, reloaded);
  const second = readFileSync(flowPath(root, "login"));
  assert.ok(first.equals(second), "read -> write produced identical bytes");
});

test("judgment slots parse and survive re-analysis", { timeout: 240_000 }, async () => {
  const root = scratch();
  const flow = await new FlowAnalyzer(root, { maxDepth: 2 }).analyze(LOGIN);
  flow.judgments.labels[flow.root] = "the login entry point";
  flow.judgments.clusters.push({ name: "auditing", members: [flow.root] });
  writeFlow(root, flow);

  const back = readFlow(root, "login");
  assert.equal(back?.judgments.labels[flow.root], "the login entry point");
  assert.equal(back?.judgments.clusters[0]?.name, "auditing");

  // Re-analysis must not discard human curation.
  const again = await new FlowAnalyzer(root, { maxDepth: 2 }).analyze(LOGIN);
  assert.equal(again.judgments.labels[flow.root], "the login entry point");
});

test("nothing populates a judgment slot by inference", { timeout: 240_000 }, async () => {
  const root = scratch();
  const flow = await new FlowAnalyzer(root, { maxDepth: 3 }).analyze(BROADCAST);
  assert.deepEqual(flow.judgments.labels, {});
  assert.deepEqual(flow.judgments.clusters, []);
  assert.deepEqual(flow.judgments.dispatch, {});
  assert.ok(flow.holes.length > 0, "the hole is left open, not judged");
});

test("a broken entry point is reported and its file is kept", { timeout: 240_000 }, async () => {
  const root = scratch();
  writeFlow(root, await new FlowAnalyzer(root, { maxDepth: 1 }).analyze(LOGIN));

  // Remove the symbol.
  const appPath = path.join(root, "app.py");
  writeFileSync(appPath, readFileSync(appPath, "utf8").replace("def login(", "def signin("));

  await assert.rejects(
    () => new FlowAnalyzer(root, { maxDepth: 1 }).analyze(LOGIN),
    (e: unknown) => {
      assert.ok(e instanceof BrokenEntryPointError);
      assert.match(e.message, /no longer resolves/);
      return true;
    },
  );

  const marked = markBroken(root, "login");
  assert.equal(marked?.broken, true);
  assert.ok(readFlow(root, "login"), "the stored flow file was retained, not deleted");
});

test("an unrelated edit leaves a hole's dependency hash unchanged", { timeout: 240_000 }, async () => {
  const root = scratch();
  const before = await new FlowAnalyzer(root, { maxDepth: 3 }).analyze(BROADCAST);
  const holeBefore = before.holes[0];
  assert.ok(holeBefore, "broadcast has an open hole");

  // Add a line to a function the hole does not depend on. The hole depends on
  // the declared target and the candidate set, not on any function body.
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      "def audit(kind: str, user: str) -> None:\n",
      "def audit(kind: str, user: str) -> None:\n    _ = 1  # unrelated\n",
    ),
  );

  const after = await new FlowAnalyzer(root, { maxDepth: 3 }).analyze(BROADCAST);
  const holeAfter = after.holes.find((h) => h.id === holeBefore.id);
  assert.ok(holeAfter, "the same hole is still present");
  assert.equal(holeAfter.depHash, holeBefore.depHash, "hole hash is unchanged");

  // And the audit node's own hash DID change, because it depends on its body.
  const auditBefore = before.nodes.find((n) => n.name === "audit");
  const auditAfter = after.nodes.find((n) => n.name === "audit");
  if (auditBefore && auditAfter) {
    assert.notEqual(auditAfter.depHash, auditBefore.depHash, "the edited node's hash changed");
  }
});

test("a new implementor changes the hole's hash", () => {
  const a = depHashes.hole("senders.py#send@1", ["senders.py#send@6", "senders.py#send@11"]);
  const b = depHashes.hole("senders.py#send@1", [
    "senders.py#send@6",
    "senders.py#send@11",
    "senders.py#send@20",
  ]);
  assert.notEqual(a, b, "adding a candidate invalidates the hole");
  const reordered = depHashes.hole("senders.py#send@1", [
    "senders.py#send@11",
    "senders.py#send@6",
  ]);
  assert.equal(a, reordered, "candidate order does not matter");
});
