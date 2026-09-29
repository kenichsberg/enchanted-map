import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowAnalyzer } from "../../src/flow/analyze.ts";
import { computeStaleness, accept } from "../../src/flow/staleness.ts";
import { flowView, diffView, stalenessView, provenanceView, conditionLabel } from "../../src/views/index.ts";
import { FIXTURE } from "../helpers.ts";

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-views-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
const flowOf = (root: string, symbol: string, depth = 3) =>
  new FlowAnalyzer(root, { maxDepth: depth }).analyze({ name: symbol, file: "app.py", symbol });

test("a view is produced with no surface attached and survives serialisation", { timeout: 240_000 }, async () => {
  const root = scratch();
  const view = flowView(await flowOf(root, "login"));
  const round = JSON.parse(JSON.stringify(view));
  assert.deepEqual(round, view, "the view object is plain JSON");
  assert.equal(view.kind, "flow");
  assert.ok(view.nodes.length > 0 && view.edges.length > 0);
});

test("whole-flow view puts guards on edges and adds no nodes for them", { timeout: 240_000 }, async () => {
  const root = scratch();
  const view = flowView(await flowOf(root, "broadcast"));
  const guarded = view.edges.filter((e) => e.conditionLabel !== "");
  assert.ok(guarded.length >= 2, "guarded edges carry a label");

  // Two edges to the same callee, separated only by their guard.
  const toNotify = view.edges.filter((e) => e.to.includes("#notify"));
  assert.equal(toNotify.length, 2);
  const labels = toNotify.map((e) => e.conditionLabel).sort();
  assert.deepEqual(labels, ["for user in users && !urgent", "for user in users && urgent"]);

  // No node represents a conditional.
  for (const n of view.nodes) {
    assert.ok(
      !/if_statement|else_clause|for_statement/.test(n.id),
      `node ${n.id} is a function, not a branch`,
    );
  }
});

test("truncation and cycles are marked, not presented as leaves", { timeout: 240_000 }, async () => {
  const root = scratch();
  const shallow = flowView(await flowOf(root, "login", 1));
  assert.ok(shallow.nodes.some((n) => n.truncated), "the frontier is marked truncated");

  const rec = flowView(await flowOf(root, "countdown", 5));
  assert.ok(rec.nodes.some((n) => n.cycle), "the recursive node is marked as a cycle");
  assert.ok(rec.edges.some((e) => e.closesCycle));
});

test("provenance view exposes tiers and candidate sets", { timeout: 240_000 }, async () => {
  const root = scratch();
  const resolved = provenanceView(await flowOf(root, "login"));
  assert.ok(resolved.tiers["lsp-verified"]!.length > 0);
  assert.ok(resolved.tiers["heuristic"]!.length > 0, "the constructor-resolved edge has its own tier");

  const open = provenanceView(await flowOf(root, "broadcast"));
  assert.equal(open.unresolved.length, 1);
  assert.equal(open.unresolved[0]?.candidates.length, 2, "the candidate set is exposed");
});

test("diff reports an added call and the node it newly reaches", { timeout: 240_000 }, async () => {
  const root = scratch();
  const before = await flowOf(root, "login");

  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      "def create_session(user: str) -> None:\n    audit(\"session\", user)",
      "def newly_called(x: str) -> None:\n    print(x)\n\n\ndef create_session(user: str) -> None:\n    audit(\"session\", user)\n    newly_called(user)",
    ),
  );
  const after = await flowOf(root, "login");
  const diff = diffView(before, after);

  assert.equal(diff.empty, false);
  assert.ok(
    diff.addedNodes.some((n) => n.label === "newly_called"),
    `added nodes: ${diff.addedNodes.map((n) => n.label).join(",")}`,
  );
  assert.ok(diff.newlyReachable.some((n) => n.label === "newly_called"));
  assert.ok(diff.addedEdges.some((e) => e.to.includes("newly_called")));
});

test("a changed guard is reported as condition-changed, not remove plus add", { timeout: 240_000 }, async () => {
  const root = scratch();
  const before = await flowOf(root, "login");

  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace("    if mfa:", "    if mfa and user:"),
  );
  const after = await flowOf(root, "login");
  const diff = diffView(before, after);

  assert.ok(diff.conditionChanged.length > 0, "the guard change was detected");
  // Both arms of the conditional legitimately changed; pick the positive one.
  const changed = diff.conditionChanged.find((c) => c.before === "mfa");
  assert.ok(
    changed,
    `expected the if-arm among: ${diff.conditionChanged.map((c) => `${c.before} -> ${c.after}`).join("; ")}`,
  );
  assert.equal(changed.after, "mfa and user");
  const negated = diff.conditionChanged.find((c) => c.before === "!mfa");
  assert.equal(negated?.after, "!mfa and user", "the else arm changed too");
  assert.ok(
    !diff.addedEdges.some((e) => e.id === changed.edge.id),
    "the edge was not reported as added",
  );
  assert.ok(
    !diff.removedEdges.some((e) => e.id === changed.edge.id),
    "the edge was not reported as removed",
  );
});

test("an unchanged flow diffs empty", { timeout: 240_000 }, async () => {
  const root = scratch();
  const a = await flowOf(root, "login");
  const b = await flowOf(root, "login");
  const diff = diffView(a, b);
  assert.equal(diff.empty, true, JSON.stringify(diff, null, 2).slice(0, 800));
});

test("staleness view localises to nodes and edges", { timeout: 240_000 }, async () => {
  const root = scratch();
  const stored = await flowOf(root, "login");
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      "def audit(kind: str, user: str) -> None:\n",
      "def audit(kind: str, user: str) -> None:\n    _x = 1\n",
    ),
  );
  const current = await flowOf(root, "login");
  const view = stalenessView(stored, computeStaleness(root, stored, current));
  assert.equal(view.stale, true);
  assert.ok(view.entries.length > 0);
  for (const e of view.entries) {
    assert.ok(e.affects, "every stale entry names what it affects");
  }
  assert.ok(
    view.staleNodeIds.length < stored.nodes.length,
    "not every node is marked stale",
  );
});

test("a current flow reports no staleness", { timeout: 240_000 }, async () => {
  const root = scratch();
  const stored = await flowOf(root, "login");
  const view = stalenessView(stored, computeStaleness(root, stored, stored));
  assert.equal(view.stale, false);
  assert.deepEqual(view.entries, []);
});

test("acceptance state is carried into the view", { timeout: 240_000 }, async () => {
  const root = scratch();
  const flow = await flowOf(root, "login");
  assert.equal(flowView(flow).acceptance, "unaccepted");
  const accepted = accept(flow, "abc123");
  const v = flowView(accepted, computeStaleness(root, accepted, flow));
  assert.equal(v.acceptance, "accepted");
  assert.equal(v.acceptedRevision, "abc123");
});

test("condition labels render negation and conjunction", () => {
  assert.equal(conditionLabel([]), "");
  assert.equal(
    conditionLabel([
      { kind: "for_statement", text: "for u in users", negated: false, line: 0 },
      { kind: "else_clause", text: "urgent", negated: true, line: 1 },
    ]),
    "for u in users && !urgent",
  );
});
