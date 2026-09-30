import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { flowView } from "../../src/views/index.ts";
import type { FlowView } from "../../src/views/index.ts";
import { FIXTURE } from "../helpers.ts";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-vseq-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

async function view(symbol: string, depth = 3): Promise<FlowView> {
  const root = repo();
  declareEntryPoint(root, { name: symbol, file: "app.py", symbol });
  const svc = new FlowService(root);
  return flowView(await svc.analyze(symbol));
}

const label = (v: FlowView, id: string) => v.nodes.find((n) => n.id === id)?.label ?? id;
const fromRoot = (v: FlowView) => v.edges.filter((e) => e.from === v.root);

test("a caller's edges are emitted in source order", { timeout: 300_000 }, async () => {
  const v = await view("login");
  const seq = fromRoot(v).map((e) => label(v, e.to));
  assert.deepEqual(seq, ["audit", "notify", "SMSSender", "create_session", "audit"]);
});

test("an argument call is subordinate, not a sibling", { timeout: 300_000 }, async () => {
  const v = await view("login");
  const edges = fromRoot(v);
  const notify = edges.find((e) => label(v, e.to) === "notify");
  const sms = edges.find((e) => label(v, e.to) === "SMSSender");
  assert.ok(notify && sms);

  assert.equal(sms.kind, "argument");
  assert.equal(sms.enclosingSite, notify.id, "it names the call it feeds");
  assert.equal(sms.nestingDepth, notify.nestingDepth + 1, "and renders one level deeper");
  assert.equal(notify.nestingDepth, 0, "the consuming call is at statement level");

  // It appears directly after the call it feeds, so a surface can indent it
  // without reordering anything.
  assert.equal(
    edges.indexOf(sms),
    edges.indexOf(notify) + 1,
    "the argument follows its consuming call immediately",
  );
  assert.equal(sms.evaluatedBeforeEnclosing, true, "and is evaluated before it");
});

test("nesting adds no nodes", { timeout: 300_000 }, async () => {
  const v = await view("login");
  // Every node is a function; none represents a call expression.
  for (const n of v.nodes) {
    assert.ok(!n.id.includes("->"), `${n.id} is a symbol, not a call site`);
  }
  assert.equal(v.counts.nodes, v.nodes.length);
  const argEdges = v.edges.filter((e) => e.kind === "argument");
  assert.ok(argEdges.length > 0, "the flow does contain nesting");

  // Every node is a symbol reached as the root, as a call target, as the
  // declared target a heuristic edge was rewritten from, or as a dispatch
  // candidate. Nesting introduces none of its own.
  const accounted = new Set<string>([v.root]);
  for (const e of v.edges) {
    accounted.add(e.from);
    accounted.add(e.to);
    if (e.declaredTarget) accounted.add(e.declaredTarget);
    for (const c of e.candidates) accounted.add(c);
  }
  for (const n of v.nodes) {
    assert.ok(accounted.has(n.id), `${n.id} was not introduced by any call or candidate`);
  }
});

test("several arguments of one call are ordered beneath it", { timeout: 300_000 }, async () => {
  const v = await view("two_args", 1);
  const edges = fromRoot(v);
  const audit = edges.find((e) => label(v, e.to) === "audit");
  const combines = edges.filter((e) => label(v, e.to) === "combine");
  assert.ok(audit);
  assert.equal(combines.length, 2);

  for (const c of combines) {
    assert.equal(c.enclosingSite, audit.id);
    assert.equal(c.nestingDepth, 1);
  }
  const [first, second] = combines;
  assert.ok(first && second);
  assert.ok(first.ordinal < second.ordinal, "ordered between themselves");
  assert.ok(
    edges.indexOf(first) < edges.indexOf(second),
    "and emitted in that order",
  );
  assert.ok(edges.indexOf(audit) < edges.indexOf(first), "both follow the call they feed");
});

test("a flow with no nesting is presented as plain siblings", { timeout: 300_000 }, async () => {
  const v = await view("countdown", 2);
  for (const e of v.edges) {
    assert.equal(e.kind, "call");
    assert.equal(e.nestingDepth, 0);
    assert.equal(e.enclosingSite, null);
    assert.equal(e.evaluatedBeforeEnclosing, false);
  }
});

test("the view is still a plain serialisable object", { timeout: 300_000 }, async () => {
  const v = await view("login");
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
});
