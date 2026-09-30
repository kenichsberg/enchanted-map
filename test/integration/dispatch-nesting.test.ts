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

test("a constructor sharing a line but not an argument position is not evidence", { timeout: 300_000 }, async () => {
  // same_line_decoy:
  //     spare = SMSSender(); notify(EmailSender(), "decoy")
  //
  // Both constructors sit on one line. Only EmailSender is an argument of the
  // call into notify, so only it is evidence. The old shared-line rule saw two
  // candidates here and gave up.
  const facts = await analyze("same_line_decoy");

  const resolved = facts.edges.find((e) => e.provenance === "heuristic");
  assert.ok(resolved, "the dispatch resolves on argument evidence alone");

  const target = facts.symbols[resolved.to];
  assert.equal(target?.file, "senders.py");
  assert.equal(
    target?.qualifiedName,
    "EmailSender.send",
    "resolved to the implementation actually passed in, not the decoy",
  );
  assert.notEqual(target?.qualifiedName, "SMSSender.send", "the same-line decoy was ignored");
  assert.equal(facts.unresolved.length, 0, "no hole remains");
});

test("the decoy constructor is still recorded as a call, just not as evidence", { timeout: 300_000 }, async () => {
  const facts = await analyze("same_line_decoy");
  const name = (id: string) => facts.symbols[id]?.name ?? id;

  const sms = facts.edges.find((e) => name(e.to) === "SMSSender");
  const email = facts.edges.find((e) => name(e.to) === "EmailSender");
  assert.ok(sms && email, "both constructors appear in the map");

  assert.equal(sms.site.kind, "call", "the decoy is a statement-level call");
  assert.equal(sms.site.enclosingSite, null);
  assert.equal(email.site.kind, "argument", "the passed sender is an argument");
  assert.ok(email.site.enclosingSite, "and it names the call it feeds");

  // They really are on the same source line -- the old rule's whole problem.
  assert.equal(
    sms.site.range.start.line,
    email.site.range.start.line,
    "both constructors share a line, which is why the line test failed here",
  );
});

test("ambiguity across separate call sites still leaves the hole open", { timeout: 300_000 }, async () => {
  // broadcast passes SMSSender at one site and EmailSender at another. Two
  // distinct candidates reach the dispatch, so the conservative rule holds.
  const facts = await analyze("broadcast");
  assert.equal(facts.unresolved.length, 1, "the hole stays open");
  assert.equal(facts.edges.filter((e) => e.provenance === "heuristic").length, 0);
  assert.equal(facts.unresolved[0]?.candidates.length, 2);
});
