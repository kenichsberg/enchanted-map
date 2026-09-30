import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { flowView } from "../../src/views/index.ts";
import type { Flow } from "../../src/flow/model.ts";
import { FIXTURE } from "../helpers.ts";

async function flowOf(symbol: string, depth = 3): Promise<Flow> {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-focus-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: symbol, file: "app.py", symbol });
  const svc = new FlowService(root);
  const cfg = svc.config();
  if (cfg.maxDepth !== depth) {
    const { saveConfig } = await import("../../src/flow/config.ts");
    saveConfig(root, { ...cfg, maxDepth: depth });
  }
  return svc.analyze(symbol);
}

const idOf = (flow: Flow, name: string) => flow.nodes.find((n) => n.name === name)?.id;

test("a focused view is rooted at the chosen node", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login");
  const notify = idOf(flow, "notify");
  assert.ok(notify);

  const v = flowView(flow, null, { focus: notify });
  assert.equal(v.root, notify, "the focused node is the root");
  assert.equal(v.focus, notify);
  assert.equal(v.entryPoint, flow.root, "the flow's own entry point is still recorded");
  assert.ok(v.nodes.some((n) => n.id === notify));
});

test("unreachable nodes are absent", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login");
  const notify = idOf(flow, "notify");
  assert.ok(notify);

  const v = flowView(flow, null, { focus: notify });
  const labels = v.nodes.map((n) => n.label);
  // create_session is the other arm of the conditional: not reachable from notify.
  assert.ok(!labels.includes("create_session"), `got ${labels.join(",")}`);
  assert.ok(v.counts.nodes < flow.nodes.length, "the view is smaller than the flow");

  // Every retained edge connects two retained nodes.
  const ids = new Set(v.nodes.map((n) => n.id));
  for (const e of v.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to), `edge ${e.id} dangles`);
  }
});

test("the path back is carried, ordered from the entry point", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login");
  // Pick a node an edge actually reaches, not a dispatch candidate.
  const targets = new Set(flow.edges.map((e) => e.to));
  const send = flow.nodes.find((n) => n.name === "send" && !n.external && targets.has(n.id))?.id;
  assert.ok(send, "a node below the entry point");

  const v = flowView(flow, null, { focus: send });
  assert.ok(v.path.length >= 2, `path: ${v.path.map((p) => p.label).join(" > ")}`);
  assert.equal(v.path[0]?.id, flow.root, "starts at the entry point");
  assert.equal(v.path[v.path.length - 1]?.id, send, "ends at the focused node");
  assert.ok(v.path.every((p) => p.label), "each step is labelled for a breadcrumb");
});

test("focusing the entry point changes nothing", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login");
  const plain = flowView(flow);
  const focused = flowView(flow, null, { focus: flow.root });

  assert.deepEqual(
    focused.nodes.map((n) => n.id).sort(),
    plain.nodes.map((n) => n.id).sort(),
  );
  assert.deepEqual(
    focused.edges.map((e) => e.id).sort(),
    plain.edges.map((e) => e.id).sort(),
  );
  assert.deepEqual(focused.path.map((p) => p.id), [flow.root], "the path is just the root");
});

test("a shared node is included when either caller is focused", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login");
  // audit is called by both login and create_session.
  const createSession = idOf(flow, "create_session");
  assert.ok(createSession);
  const v = flowView(flow, null, { focus: createSession });
  assert.ok(
    v.nodes.some((n) => n.label === "audit"),
    "a helper reached from two places is part of what this node does",
  );
});

test("truncation survives focus", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login", 1);
  const truncated = flow.truncated[0];
  assert.ok(truncated, "depth 1 truncates something");

  const v = flowView(flow, null, { focus: truncated });
  const node = v.nodes.find((n) => n.id === truncated);
  assert.ok(node);
  assert.equal(
    node.truncated,
    true,
    "a frontier node must not read as a node that calls nothing",
  );
});

test("a cycle survives focus and terminates", { timeout: 300_000 }, async () => {
  const flow = await flowOf("countdown", 5);
  const countdown = idOf(flow, "countdown");
  assert.ok(countdown);

  const v = flowView(flow, null, { focus: countdown });
  assert.ok(v.nodes.some((n) => n.cycle), "the cycle mark is kept");
  assert.ok(v.edges.some((e) => e.closesCycle));
});

test("a focused view is still plain and serialisable", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login");
  const v = flowView(flow, null, { focus: idOf(flow, "notify") });
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
});

test("a node no call reaches yields no invented path", { timeout: 300_000 }, async () => {
  const flow = await flowOf("broadcast");
  const targets = new Set(flow.edges.map((e) => e.to));
  // A dispatch candidate: present in the flow, reached by no edge.
  const candidate = flow.nodes.find((n) => !n.external && !targets.has(n.id) && n.id !== flow.root);
  if (!candidate) return;

  const v = flowView(flow, null, { focus: candidate.id });
  assert.deepEqual(v.path, [], "an unreachable node gets an empty path, not a fabricated one");
  assert.equal(v.root, candidate.id);
});

test("an unknown focus falls back to the whole flow", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login");
  const v = flowView(flow, null, { focus: "does/not#exist" });
  assert.equal(v.focus, null, "an unresolvable focus is ignored rather than emptying the view");
  assert.equal(v.counts.nodes, flow.nodes.length);
});
