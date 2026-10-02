import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { readFlow } from "../../src/flow/store.ts";
import { McpServer, serveMcpStdio, type JsonRpcMessage } from "../../src/sidecar/mcp.ts";
import { flowView, provenanceView } from "../../src/views/index.ts";
import { curate } from "../../src/flow/judgments.ts";
import { FIXTURE } from "../helpers.ts";

const TIMEOUT = { timeout: 300_000 };

/** A throwaway copy of the fixture with `broadcast` analyzed and stored. */
async function project(): Promise<{ root: string; svc: FlowService; mcp: McpServer }> {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-mcp-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "broadcast", file: "app.py", symbol: "broadcast" });
  const svc = new FlowService(root);
  await svc.refresh("broadcast");
  return { root, svc, mcp: new McpServer(svc) };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(
  mcp: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const res = await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return (res as { result: ToolResult }).result;
}

async function holesOf(mcp: McpServer): Promise<
  Array<{
    id: string;
    candidates: Array<{ index: number; id: string }>;
    judgment: { state: string; outcome: string; target: string | null } | null;
  }>
> {
  const r = await callTool(mcp, "list_holes", { flow: "broadcast" });
  assert.equal(r.isError, false, r.content[0]?.text);
  return JSON.parse(r.content[0]?.text ?? "{}").holes;
}

// --------------------------------------------------------------- protocol ---

test("the handshake answers with tools and no credential", TIMEOUT, async () => {
  const { mcp } = await project();
  const init = (await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  })) as { result: Record<string, unknown> };

  assert.equal(init.result["protocolVersion"], "2025-06-18");
  assert.deepEqual(init.result["capabilities"], { tools: { listChanged: false } });
  assert.deepEqual(init.result["serverInfo"], { name: "enchanted-map", version: "0.1.0" });

  assert.equal(
    await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    null,
    "a notification gets no reply",
  );

  const listed = (await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
    result: { tools: Array<{ name: string; inputSchema: unknown; description: string }> };
  };
  const names = listed.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "analyze_flow",
    "decline_dispatch",
    "list_flows",
    "list_holes",
    "resolve_dispatch",
    "withdraw_judgment",
  ]);
  for (const t of listed.result.tools) {
    assert.ok(t.description.length > 20, `${t.name} needs a usable description`);
    assert.equal((t.inputSchema as { type: string }).type, "object");
  }
});

test("an unknown method is a protocol error, not a crash", TIMEOUT, async () => {
  const { mcp } = await project();
  const res = (await mcp.handle({ jsonrpc: "2.0", id: 9, method: "resources/list" })) as {
    error: { code: number };
  };
  assert.equal(res.error.code, -32601);
});

test("the stdio transport frames one message per line", TIMEOUT, async () => {
  const { mcp } = await project();
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    for (const l of c.split("\n")) if (l.trim()) lines.push(l);
  });
  serveMcpStdio(mcp, input, output);

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write("not json\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await new Promise((r) => setTimeout(r, 200));

  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(parsed.length, 3, `initialize, parse error, tools/list -- got ${lines.join(" | ")}`);
  assert.equal(parsed[0]?.["id"], 1);
  assert.equal((parsed[1]?.["error"] as { code: number }).code, -32700);
  assert.equal(parsed[2]?.["id"], 2);
});

// ------------------------------------------------------------ enumerating ---

test("a flow's open holes are offered with ordered candidates", TIMEOUT, async () => {
  const { mcp } = await project();
  const holes = await holesOf(mcp);
  assert.ok(holes.length > 0, "the fixture's broadcast has a genuine dispatch hole");
  const h = holes[0];
  assert.ok(h);
  assert.ok(h.candidates.length >= 2, "a hole worth asking about has more than one answer");
  assert.deepEqual(
    h.candidates.map((c) => c.index),
    h.candidates.map((_, i) => i),
    "indices are the positions a resolution names",
  );
  assert.equal(h.judgment, null, "nothing has been judged yet");

  const again = await holesOf(mcp);
  assert.deepEqual(
    again.map((x) => x.candidates.map((c) => c.id)),
    holes.map((x) => x.candidates.map((c) => c.id)),
    "candidate order is stable, or an index means nothing",
  );
});

test("list_flows reports what is open and what has been judged", TIMEOUT, async () => {
  const { mcp } = await project();
  const before = JSON.parse((await callTool(mcp, "list_flows")).content[0]?.text ?? "{}");
  const entry = before.flows.find((f: { flow: string }) => f.flow === "broadcast");
  assert.equal(entry.judged, 0);
  assert.ok(entry.openHoles > 0);

  const holes = await holesOf(mcp);
  await callTool(mcp, "resolve_dispatch", {
    flow: "broadcast",
    hole: holes[0]?.id,
    candidate: 0,
  });

  const after = JSON.parse((await callTool(mcp, "list_flows")).content[0]?.text ?? "{}");
  const now = after.flows.find((f: { flow: string }) => f.flow === "broadcast");
  assert.equal(now.judged, 1);
  assert.equal(now.openHoles, entry.openHoles - 1, "a resolved hole leaves the list");
});

// -------------------------------------------------------------- resolving ---

test("a resolution reaches the stored flow and every view", TIMEOUT, async () => {
  const { root, svc, mcp } = await project();
  const holes = await holesOf(mcp);
  const hole = holes[0];
  assert.ok(hole);
  const chosen = hole.candidates[1]?.id;
  assert.ok(chosen);

  const res = await callTool(mcp, "resolve_dispatch", {
    flow: "broadcast",
    hole: hole.id,
    candidate: 1,
    confidence: "likely",
    note: "the urgent arm constructs this one",
    by: "test-agent",
  });
  assert.equal(res.isError, false, res.content[0]?.text);

  const stored = readFlow(root, "broadcast");
  assert.ok(stored);
  const siteId = hole.id.replace(/^hole:/, "");
  const judgment = stored.judgments.dispatch[siteId];
  assert.ok(judgment, "stored against the call site");
  assert.equal(judgment.target, chosen);
  assert.equal(judgment.confidence, "likely");
  assert.equal(judgment.by, "test-agent");
  assert.ok(judgment.at, "and when");
  assert.ok(judgment.depHash, "and on what inputs");
  assert.equal(judgment.note, "the urgent arm constructs this one");

  // The facts are untouched: the hole and the declared target are still there,
  // which is what makes a withdrawal a restoration rather than a repair.
  assert.ok(stored.holes.some((h) => h.id === hole.id), "the stored hole survives");
  assert.equal(stored.edges.find((e) => e.id === siteId)?.provenance, "declared-unresolved");

  const view = flowView(stored);
  const edge = view.edges.find((e) => e.id === siteId);
  assert.equal(edge?.to, chosen, "the view points at the chosen implementation");
  assert.equal(edge?.provenance, "agent-inferred", "and says it was judged, not verified");
  assert.equal(edge?.judgment?.confidence, "likely", "the decision stays inspectable");
  assert.ok((edge?.candidates.length ?? 0) >= 2, "with the set it chose from");
  assert.ok(!view.holes.some((h) => h.id === hole.id), "the hole leaves the list");
  assert.equal(view.counts.judged, 1);

  const prov = provenanceView(stored);
  assert.ok(prov.tiers["agent-inferred"]?.includes(siteId));
  assert.ok(!prov.tiers["lsp-verified"]?.includes(siteId), "never presented as a fact");
  assert.equal(prov.inferred[0]?.chosen, chosen);
  assert.equal(prov.inferred[0]?.confidence, "likely");

  // Shared state, not a private one: a second service over the same root sees it.
  assert.equal(new FlowService(root).curated("broadcast")?.edges.find((e) => e.id === siteId)?.to, chosen);
  assert.equal(svc.holes("broadcast").find((h) => h.id === hole.id)?.judgment?.state, "current");
});

test("a judged hole is marked so it is not re-answered", TIMEOUT, async () => {
  const { mcp } = await project();
  const holes = await holesOf(mcp);
  await callTool(mcp, "resolve_dispatch", { flow: "broadcast", hole: holes[0]?.id, candidate: 0 });

  const after = await holesOf(mcp);
  const same = after.find((h) => h.id === holes[0]?.id);
  assert.equal(same?.judgment?.state, "current");
  assert.equal(same?.judgment?.outcome, "resolved");

  const summary = JSON.parse(
    (await callTool(mcp, "list_holes", { flow: "broadcast" })).content[0]?.text ?? "{}",
  );
  assert.equal(summary.open, after.length - 1, "the settled one is not counted as open");
});

// ------------------------------------------------------------- refusals ----

test("a position outside the candidate list is refused, naming the candidates", TIMEOUT, async () => {
  const { root, mcp } = await project();
  const holes = await holesOf(mcp);
  const hole = holes[0];
  assert.ok(hole);

  const res = await callTool(mcp, "resolve_dispatch", {
    flow: "broadcast",
    hole: hole.id,
    candidate: hole.candidates.length,
  });
  assert.equal(res.isError, true);
  for (const c of hole.candidates) {
    assert.ok(
      res.content[0]?.text.includes(c.id),
      `the refusal must name candidate ${c.id}: ${res.content[0]?.text}`,
    );
  }
  assert.deepEqual(readFlow(root, "broadcast")?.judgments.dispatch, {}, "and store nothing");
});

test("an unknown hole or flow is refused and stores nothing", TIMEOUT, async () => {
  const { root, mcp } = await project();
  const bogus = await callTool(mcp, "resolve_dispatch", {
    flow: "broadcast",
    hole: "hole:does-not-exist",
    candidate: 0,
  });
  assert.equal(bogus.isError, true);

  const noFlow = await callTool(mcp, "list_holes", { flow: "no-such-flow" });
  assert.equal(noFlow.isError, true);
  assert.match(noFlow.content[0]?.text ?? "", /has not been analyzed/);

  assert.deepEqual(readFlow(root, "broadcast")?.judgments.dispatch, {});
});

test("a judgment cannot name a symbol outside its hole's candidates", TIMEOUT, async () => {
  const { root, mcp } = await project();
  const holes = await holesOf(mcp);
  const hole = holes[0];
  assert.ok(hole);
  const legal = new Set(hole.candidates.map((c) => c.id));

  // Every shape an argument could take, including the ones a model would reach
  // for if it wanted to name a symbol directly. There is no parameter here that
  // accepts a symbol, which is the point: the invalid case is unrepresentable.
  const attempts: unknown[] = [
    -1,
    hole.candidates.length,
    999,
    1.5,
    Number.NaN,
    "0",
    "senders.py#NotACandidate.send",
    null,
    { id: "senders.py#NotACandidate.send" },
    ["senders.py#NotACandidate.send"],
  ];
  for (const candidate of attempts) {
    await callTool(mcp, "resolve_dispatch", { flow: "broadcast", hole: hole.id, candidate });
    const stored = readFlow(root, "broadcast");
    for (const [, j] of Object.entries(stored?.judgments.dispatch ?? {})) {
      assert.ok(
        j.target === null || legal.has(j.target),
        `candidate=${JSON.stringify(candidate)} stored ${j.target}, which was never offered`,
      );
    }
  }
});

// -------------------------------------------------------------- declining ---

test("a decline is recorded, resolves nothing, and is not re-asked", TIMEOUT, async () => {
  const { root, mcp } = await project();
  const holes = await holesOf(mcp);
  const hole = holes[0];
  assert.ok(hole);

  const res = await callTool(mcp, "decline_dispatch", {
    flow: "broadcast",
    hole: hole.id,
    reason: "the sender is chosen by a config flag read at runtime",
  });
  assert.equal(res.isError, false, res.content[0]?.text);

  const stored = readFlow(root, "broadcast");
  assert.ok(stored);
  const siteId = hole.id.replace(/^hole:/, "");
  assert.equal(stored.judgments.dispatch[siteId]?.outcome, "declined");
  assert.equal(stored.judgments.dispatch[siteId]?.target, null);

  const view = flowView(stored);
  assert.equal(
    view.edges.find((e) => e.id === siteId)?.provenance,
    "declared-unresolved",
    "declining is an answer about the question, not an answer to it",
  );
  const listed = view.holes.find((h) => h.id === hole.id);
  assert.ok(listed, "the hole is still open");
  assert.equal(listed.judgment?.outcome, "declined", "but visibly considered");
  assert.match(listed.judgment?.note ?? "", /config flag/);

  const offered = await holesOf(mcp);
  assert.equal(offered.find((h) => h.id === hole.id)?.judgment?.state, "current");
});

test("a decline with no reason is refused", TIMEOUT, async () => {
  const { mcp } = await project();
  const holes = await holesOf(mcp);
  const res = await callTool(mcp, "decline_dispatch", {
    flow: "broadcast",
    hole: holes[0]?.id,
    reason: "",
  });
  assert.equal(res.isError, true);
});

// ------------------------------------------------------------ withdrawal ---

test("withdrawing returns the hole and the declared target", TIMEOUT, async () => {
  const { root, mcp } = await project();
  const holes = await holesOf(mcp);
  const hole = holes[0];
  assert.ok(hole);
  const siteId = hole.id.replace(/^hole:/, "");
  const declared = readFlow(root, "broadcast")?.edges.find((e) => e.id === siteId)?.to;

  await callTool(mcp, "resolve_dispatch", { flow: "broadcast", hole: hole.id, candidate: 0 });
  assert.equal(flowView(readFlow(root, "broadcast")!).counts.judged, 1);

  const res = await callTool(mcp, "withdraw_judgment", { flow: "broadcast", hole: hole.id });
  assert.equal(res.isError, false, res.content[0]?.text);

  const stored = readFlow(root, "broadcast");
  assert.ok(stored);
  assert.deepEqual(stored.judgments.dispatch, {});
  const view = flowView(stored);
  assert.equal(view.edges.find((e) => e.id === siteId)?.to, declared);
  assert.equal(view.edges.find((e) => e.id === siteId)?.provenance, "declared-unresolved");
  assert.ok(view.holes.some((h) => h.id === hole.id), "the hole is open again");

  const twice = await callTool(mcp, "withdraw_judgment", { flow: "broadcast", hole: hole.id });
  assert.equal(twice.isError, true, "withdrawing nothing is refused rather than silently fine");
});

// ------------------------------------------------------------- staleness ---

test("a new implementor reopens the question", TIMEOUT, async () => {
  const { root, svc, mcp } = await project();
  const holes = await holesOf(mcp);
  const hole = holes[0];
  assert.ok(hole);
  const siteId = hole.id.replace(/^hole:/, "");
  await callTool(mcp, "resolve_dispatch", { flow: "broadcast", hole: hole.id, candidate: 0 });
  assert.equal(svc.holes("broadcast").find((h) => h.id === hole.id)?.judgment?.state, "current");

  const senders = path.join(root, "senders.py");
  writeFileSync(
    senders,
    readFileSync(senders, "utf8") +
      "\n\nclass FaxSender(Sender):\n    def send(self, msg: str) -> None:\n        _deliver(\"fax\", msg)\n",
    "utf8",
  );
  await svc.refresh("broadcast");

  const stored = readFlow(root, "broadcast");
  assert.ok(stored);
  assert.ok(stored.judgments.dispatch[siteId], "the judgment is kept, not discarded");

  const { applied } = curate(stored);
  assert.equal(applied[0]?.state, "stale", "its candidate set moved beneath it");
  const view = flowView(stored);
  assert.equal(
    view.edges.find((e) => e.id === siteId)?.provenance,
    "declared-unresolved",
    "so the edge is unresolved again rather than quietly wrong",
  );
  assert.ok(view.holes.some((h) => h.id === hole.id), "and the hole returns to the list");
  assert.equal(view.counts.staleJudgments, 1);
});

test("an unrelated edit does not reopen it", TIMEOUT, async () => {
  const { root, svc, mcp } = await project();
  const holes = await holesOf(mcp);
  const hole = holes[0];
  assert.ok(hole);
  const siteId = hole.id.replace(/^hole:/, "");
  await callTool(mcp, "resolve_dispatch", { flow: "broadcast", hole: hole.id, candidate: 0 });
  const chosen = flowView(readFlow(root, "broadcast")!).edges.find((e) => e.id === siteId)?.to;

  // Edit a function in the flow that has nothing to do with the dispatch.
  const app = path.join(root, "app.py");
  writeFileSync(
    app,
    readFileSync(app, "utf8").replace(
      'def audit(kind: str, user: str) -> None:\n    print(kind, user)',
      'def audit(kind: str, user: str) -> None:\n    print("audit", kind, user)',
    ),
    "utf8",
  );
  await svc.refresh("broadcast");

  const stored = readFlow(root, "broadcast");
  assert.ok(stored);
  assert.equal(
    curate(stored).applied[0]?.state,
    "current",
    "the hash covers what the decision was about, not every line near it",
  );
  const view = flowView(stored);
  assert.equal(view.edges.find((e) => e.id === siteId)?.to, chosen);
  assert.equal(view.edges.find((e) => e.id === siteId)?.provenance, "agent-inferred");
  assert.equal(view.counts.staleJudgments, 0);
});

// ------------------------------------------------------------ guardrails ---

test("analysis writes no judgment", TIMEOUT, async () => {
  const { root, svc } = await project();
  assert.deepEqual(readFlow(root, "broadcast")?.judgments.dispatch, {});
  await svc.refresh("broadcast");
  assert.deepEqual(
    readFlow(root, "broadcast")?.judgments.dispatch,
    {},
    "analysis derives facts; it never decides anything",
  );
  assert.deepEqual(readFlow(root, "broadcast")?.judgments.labels, {});
  assert.deepEqual(readFlow(root, "broadcast")?.judgments.clusters, []);
});

test("curation survives re-analysis", TIMEOUT, async () => {
  const { root, svc, mcp } = await project();
  const holes = await holesOf(mcp);
  await callTool(mcp, "resolve_dispatch", {
    flow: "broadcast",
    hole: holes[0]?.id,
    candidate: 0,
    note: "kept",
  });
  const before = readFlow(root, "broadcast")?.judgments.dispatch;

  await svc.refresh("broadcast");
  assert.deepEqual(
    readFlow(root, "broadcast")?.judgments.dispatch,
    before,
    "judgments are the one part of a flow file that cannot be regenerated",
  );
  assert.equal(flowView(readFlow(root, "broadcast")!).counts.judged, 1);
});

test("the staleness check reports and writes nothing", TIMEOUT, async () => {
  const { root, svc, mcp } = await project();
  const holes = await holesOf(mcp);
  const siteId = (holes[0]?.id ?? "").replace(/^hole:/, "");
  await callTool(mcp, "resolve_dispatch", { flow: "broadcast", hole: holes[0]?.id, candidate: 0 });

  const senders = path.join(root, "senders.py");
  writeFileSync(
    senders,
    readFileSync(senders, "utf8") +
      "\n\nclass FaxSender(Sender):\n    def send(self, msg: str) -> None:\n        _deliver(\"fax\", msg)\n",
    "utf8",
  );

  const before = readFileSync(path.join(root, ".enchanted", "flows", "broadcast.yaml"), "utf8");
  const status = await svc.status("broadcast");
  const after = readFileSync(path.join(root, ".enchanted", "flows", "broadcast.yaml"), "utf8");
  assert.equal(after, before, "checking is a read; it must not curate and must not store");

  // …and it reports the judgment in its own right. "The hole changed" is free
  // to re-derive; "the answer given for it no longer holds" is work for a
  // person, and collapsing the two hides the only one that costs anything.
  assert.ok(status.report, "the check ran");
  const judgments = status.report.entries.filter((e) => e.kind === "judgment");
  assert.equal(judgments.length, 1, JSON.stringify(status.report.entries));
  assert.equal(judgments[0]?.reason, "changed");
  assert.equal(judgments[0]?.affects, siteId);

  // The stored flow is still internally consistent: nothing has been rewritten
  // under it, so the judgment reads as current against the facts it was given.
  assert.equal(curate(readFlow(root, "broadcast")!).applied[0]?.state, "current");
});
