import { test } from "node:test";
import assert from "node:assert/strict";
import { LanguageServer } from "../../src/lsp/server.ts";
import { Extractor } from "../../src/analysis/extract.ts";
import { BranchIndex } from "../../src/analysis/branches.ts";
import { DispatchResolver } from "../../src/analysis/dispatch.ts";
import type { FlowFacts } from "../../src/analysis/types.ts";
import { FIXTURE, findDef } from "../helpers.ts";

async function analyze(symbol: string, depth = 3): Promise<FlowFacts> {
  const server = new LanguageServer(FIXTURE);
  await server.start();
  try {
    const branches = await BranchIndex.create(FIXTURE);
    const ex = new Extractor(server, branches);
    const pos = findDef("app.py", symbol);
    const root = await ex.prepare("app.py", pos.line, pos.character);
    if (!root) throw new Error(`could not prepare ${symbol}`);
    const facts = await ex.traverse(root, { maxDepth: depth });
    await new DispatchResolver(server, ex).annotate(facts);
    branches.dispose();
    return facts;
  } finally {
    await server.stop();
  }
}

const named = (f: FlowFacts, name: string) =>
  Object.values(f.symbols).filter((s) => s.name === name);

test("finds candidate implementations behind a declared base type", { timeout: 180_000 }, async () => {
  const facts = await analyze("broadcast");
  const dispatch = facts.edges.find((e) => e.candidates.length > 0);
  assert.ok(dispatch, "a dispatching edge was found");
  const files = dispatch.candidates.map((c) => `${c.file}:${c.selectionRange.start.line + 1}`);
  assert.equal(dispatch.candidates.length, 2, `candidates: ${files.join(", ")}`);
  assert.ok(files.includes("senders.py:7"), "SMSSender.send is a candidate");
  assert.ok(files.includes("senders.py:12"), "EmailSender.send is a candidate");
});

test("leaves the hole open when two candidates are constructed", { timeout: 180_000 }, async () => {
  const facts = await analyze("broadcast");
  assert.equal(facts.unresolved.length, 1, "exactly one hole");
  const hole = facts.unresolved[0];
  assert.ok(hole);
  assert.equal(hole.reason, "dispatch-candidates");
  assert.equal(hole.candidates.length, 2);
  const edge = facts.edges.find((e) => e.site.id === hole.siteId && e.candidates.length > 0);
  assert.equal(edge?.provenance, "declared-unresolved", "edge marked at reduced confidence");
  assert.equal(
    facts.symbols[edge!.to]?.selectionRange.start.line,
    1,
    "edge still points at the declared base method (senders.py line 2)",
  );
});

test("resolves by constructor evidence when exactly one is constructed", { timeout: 180_000 }, async () => {
  const facts = await analyze("login");
  assert.equal(facts.unresolved.length, 0, "the hole is closed");
  const edge = facts.edges.find((e) => e.provenance === "heuristic");
  assert.ok(edge, "a heuristically resolved edge exists");
  const target = facts.symbols[edge.to];
  assert.equal(target?.file, "senders.py");
  assert.equal(target?.selectionRange.start.line, 6, "resolved to SMSSender.send (line 7)");
  assert.ok(edge.declaredTarget, "the declared target is retained");
  assert.equal(
    facts.symbols[edge.declaredTarget]?.selectionRange.start.line,
    1,
    "declared target was Sender.send",
  );
});

test("heuristic edges are distinguishable from verified ones", { timeout: 180_000 }, async () => {
  const facts = await analyze("login");
  const tiers = new Set(facts.edges.map((e) => e.provenance));
  assert.ok(tiers.has("lsp-verified"));
  assert.ok(tiers.has("heuristic"));
  for (const e of facts.edges) {
    assert.ok(
      ["lsp-verified", "heuristic", "declared-unresolved"].includes(e.provenance),
      `every edge carries a tier, got ${e.provenance}`,
    );
  }
});

test("indirect construction is not guessed at", { timeout: 180_000 }, async () => {
  // `ambiguous()` builds the sender in a conditional expression on a previous
  // line, so there is no single-hop evidence. The hole must stay open.
  const facts = await analyze("ambiguous");
  assert.equal(facts.unresolved.length, 1, "no evidence means no resolution");
  assert.equal(facts.edges.filter((e) => e.provenance === "heuristic").length, 0);
});

test("holes are enumerable for a flow", { timeout: 180_000 }, async () => {
  const facts = await analyze("broadcast");
  assert.ok(Array.isArray(facts.unresolved));
  for (const h of facts.unresolved) {
    assert.ok(h.id && h.siteId && h.declaredTarget, "each hole is fully identified");
    assert.ok(facts.edges.some((e) => e.site.id === h.siteId), "hole points at a real call site");
  }
  assert.ok(named(facts, "send").length >= 3, "declared + both candidates are in the symbol table");
});
