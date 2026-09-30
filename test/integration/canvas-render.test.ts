import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { flowView } from "../../src/views/index.ts";
import type { FlowView } from "../../src/views/index.ts";
// The canvas's own rendering code, exercised directly.
import { layout, renderFlow } from "../../src/sidecar/render.mjs";
import { FIXTURE } from "../helpers.ts";

async function view(symbol: string, depth = 3): Promise<FlowView> {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-canvas-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: symbol, file: "app.py", symbol });
  return flowView(await new FlowService(root).analyze(symbol));
}

const idOf = (v: FlowView, label: string) => v.nodes.find((n) => n.label === label)?.id;

test("an argument call docks into the node it feeds", { timeout: 300_000 }, async () => {
  const v = await view("login");
  const { nodes, dockedIds, dockedInto } = layout(v) as {
    nodes: Map<string, { id: string; h: number }>;
    dockedIds: Set<string>;
    dockedInto: Map<string, unknown[]>;
  };

  const sms = idOf(v, "SMSSender");
  const notify = idOf(v, "notify");
  assert.ok(sms && notify);

  assert.ok(dockedIds.has(sms), "SMSSender docks rather than standing alone");
  assert.ok(!nodes.has(sms), "it gets no free-standing box");
  assert.equal(dockedInto.get(notify)?.length, 1, "it docks into notify");
  assert.ok(nodes.has(notify), "notify is still a node");
});

test("no arrow leaves the caller for a docked argument", { timeout: 300_000 }, async () => {
  const v = await view("login");
  const svg = renderFlow(v) as string;

  const esc = (t: string) =>
    t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

  const sms = idOf(v, "SMSSender")!;
  const callerEdge = v.edges.find((e) => e.from === v.root && e.to === sms);
  assert.ok(callerEdge, "the caller-to-argument edge exists in the data");
  assert.ok(
    !svg.includes(`<title>${esc(callerEdge.id)}</title>`),
    "…but it is not drawn as an edge leaving login, which is what made it look parallel",
  );

  // The genuine alternative branch IS still drawn.
  const sessionEdge = v.edges.find((e) => e.to === idOf(v, "create_session"));
  assert.ok(sessionEdge);
  assert.ok(
    svg.includes(`<title>${esc(sessionEdge.id)}</title>`),
    "a real branch still leaves the caller",
  );
});

test("the docked row is rendered, labelled, and clickable", { timeout: 300_000 }, async () => {
  const v = await view("login");
  const svg = renderFlow(v) as string;

  assert.match(svg, /class="node dock"/, "a dock row is emitted");
  assert.match(svg, /◂ SMSSender/, "labelled with the argument's name");
  assert.match(svg, /argument of notify, evaluated first/, "and says what it feeds");

  // Jump-to-source must work from the dock row, so it carries its own target.
  const dock = svg.match(/<g class="node dock" data-file="([^"]+)" data-line="(\d+)"/);
  assert.ok(dock, "the dock row carries its own jump target");
  assert.equal(dock[1], "senders.py", "pointing at SMSSender's file, not notify's");
});

test("the consuming node grows to contain its docked rows", { timeout: 300_000 }, async () => {
  const v = await view("login");
  const { nodes } = layout(v) as { nodes: Map<string, { h: number }> };
  const notify = nodes.get(idOf(v, "notify")!);
  const session = nodes.get(idOf(v, "create_session")!);
  assert.ok(notify && session);
  assert.ok(notify.h > session.h, "the node with a docked argument is taller");
});

test("an argument with its own subtree stays free-standing", { timeout: 300_000 }, async () => {
  // describe() is passed as an argument to audit() but calls audit() itself.
  // Docking it would hide a node that has outgoing edges.
  const v = await view("arg_with_subtree", 2);
  const { dockedIds, nodes } = layout(v);
  const describe = idOf(v, "describe");
  assert.ok(describe);
  assert.ok(
    v.edges.some((e) => e.from === describe),
    "the fixture's argument really does have a subtree",
  );
  assert.ok(!dockedIds.has(describe), "so it is not docked away");
  assert.ok(nodes.has(describe), "and keeps its own node");
});

test("two arguments feeding one call both dock", { timeout: 300_000 }, async () => {
  // combine() is a leaf called only in argument position, twice.
  const v = await view("two_args", 2);
  const { dockedIds, dockedInto } = layout(v);
  const combine = idOf(v, "combine");
  const audit = idOf(v, "audit");
  assert.ok(combine && audit);
  assert.ok(dockedIds.has(combine), "a leaf argument docks");
  assert.equal(dockedInto.get(audit)?.length, 2, "both argument rows dock into audit");
});

test("a flow with no nesting renders no dock rows", { timeout: 300_000 }, async () => {
  const v = await view("countdown", 2);
  const svg = renderFlow(v) as string;
  assert.ok(!svg.includes('class="node dock"'), "nothing to dock");
  assert.match(svg, /<svg /, "and it still renders");
});

test("the rendered SVG is well-formed and balanced", { timeout: 300_000 }, async () => {
  const svg = renderFlow(await view("login")) as string;
  const open = (svg.match(/<g[ >]/g) ?? []).length;
  const close = (svg.match(/<\/g>/g) ?? []).length;
  assert.equal(open, close, "every group is closed");
  assert.equal((svg.match(/<svg/g) ?? []).length, 1);
  assert.equal((svg.match(/<\/svg>/g) ?? []).length, 1);
});
