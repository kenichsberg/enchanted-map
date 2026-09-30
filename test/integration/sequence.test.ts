import { test } from "node:test";
import assert from "node:assert/strict";
import { LanguageServer } from "../../src/lsp/server.ts";
import { Extractor } from "../../src/analysis/extract.ts";
import { BranchIndex } from "../../src/analysis/branches.ts";
import type { FlowFacts } from "../../src/analysis/types.ts";
import { FIXTURE, findDef } from "../helpers.ts";

async function analyze(symbol: string, depth = 1, withBranches = true): Promise<FlowFacts> {
  const server = new LanguageServer(FIXTURE);
  await server.start();
  try {
    const branches = withBranches ? await BranchIndex.create(FIXTURE) : undefined;
    const ex = new Extractor(server, branches);
    const pos = findDef("app.py", symbol);
    const root = await ex.prepare("app.py", pos.line, pos.character);
    if (!root) throw new Error(`could not prepare ${symbol}`);
    const facts = await ex.traverse(root, { maxDepth: depth });
    branches?.dispose();
    return facts;
  } finally {
    await server.stop();
  }
}

const name = (f: FlowFacts, id: string) => f.symbols[id]?.name ?? id;
const ofCaller = (f: FlowFacts, caller: string) =>
  f.edges
    .filter((e) => name(f, e.from) === caller)
    .sort((a, b) => a.site.ordinal - b.site.ordinal);

test("ordinals follow source order, not the order the server reported", { timeout: 300_000 }, async () => {
  const facts = await analyze("login");
  const seq = ofCaller(facts, "login").map((e) => name(facts, e.to));

  // The language server groups call sites by callee, which puts the line-29
  // `audit` next to the line-21 one. Source order is what the reader needs.
  assert.deepEqual(seq, ["audit", "notify", "SMSSender", "create_session", "audit"]);

  const ordinals = ofCaller(facts, "login").map((e) => e.site.ordinal);
  assert.deepEqual(ordinals, [0, 1, 2, 3, 4], "ordinals are contiguous from zero");

  const lines = ofCaller(facts, "login").map((e) => e.site.range.start.line);
  assert.deepEqual([...lines].sort((a, b) => a - b), lines, "ordinals ascend with position");
});

test("a call in an argument position names the call it feeds", { timeout: 300_000 }, async () => {
  const facts = await analyze("login");
  const edges = ofCaller(facts, "login");
  const sms = edges.find((e) => name(facts, e.to) === "SMSSender");
  const notify = edges.find((e) => name(facts, e.to) === "notify");
  assert.ok(sms && notify);

  assert.equal(sms.site.kind, "argument");
  assert.equal(sms.site.enclosingSite, notify.site.id, "it feeds the notify call site");
  assert.ok(
    sms.site.ordinal > notify.site.ordinal,
    "the argument follows its consuming call in source order",
  );
});

test("a statement-level call is not an argument", { timeout: 300_000 }, async () => {
  const facts = await analyze("login");
  for (const e of ofCaller(facts, "login")) {
    if (name(facts, e.to) === "SMSSender") continue;
    assert.equal(e.site.kind, "call", `${name(facts, e.to)} is at statement level`);
    assert.equal(e.site.enclosingSite, null);
  }
});

test("several calls in one argument list share an enclosing site and are ordered", { timeout: 300_000 }, async () => {
  const facts = await analyze("two_args");
  const edges = ofCaller(facts, "two_args");
  const audit = edges.find((e) => name(facts, e.to) === "audit");
  const combines = edges.filter((e) => name(facts, e.to) === "combine");
  assert.ok(audit);
  assert.equal(combines.length, 2, "both argument calls are recorded");

  for (const c of combines) {
    assert.equal(c.site.kind, "argument");
    assert.equal(c.site.enclosingSite, audit.site.id, "both feed the same call site");
  }
  assert.notEqual(
    combines[0]!.site.ordinal,
    combines[1]!.site.ordinal,
    "the two arguments are ordered relative to one another",
  );
  assert.equal(new Set(combines.map((c) => c.id)).size, 2, "each remains individually addressable");
});

test("recording order and nesting does not change what is reached", { timeout: 300_000 }, async () => {
  const facts = await analyze("login", 3);

  // No node exists that is not the root or the target of a real call site.
  // Nesting is metadata on edges; it must never synthesise a node.
  const targets = new Set(facts.edges.map((e) => e.to));
  for (const id of Object.keys(facts.symbols)) {
    assert.ok(
      id === facts.root || targets.has(id),
      `${id} must be reachable through an edge, not invented by nesting`,
    );
  }

  // Every edge corresponds to exactly one call site.
  assert.equal(
    new Set(facts.edges.map((e) => e.site.id)).size,
    facts.edges.length,
    "one edge per call site, none synthesised",
  );

  // An argument call is still a call made by the caller, at the same depth as
  // its statement-level siblings -- it is not pushed a level down.
  const sms = facts.edges.find((e) => name(facts, e.to) === "SMSSender");
  const session = facts.edges.find((e) => name(facts, e.to) === "create_session");
  assert.ok(sms && session);
  assert.equal(sms.site.kind, "argument");
  assert.equal(session.site.kind, "call");
  assert.equal(sms.from, session.from, "both are calls made by the same caller");
  assert.equal(sms.from, facts.root);
  assert.ok(facts.symbols[sms.to], "the argument's target is a first-class node");
});
