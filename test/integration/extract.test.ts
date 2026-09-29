import { test } from "node:test";
import assert from "node:assert/strict";
import { LanguageServer } from "../../src/lsp/server.ts";
import { Extractor } from "../../src/analysis/extract.ts";
import { FIXTURE, findDef } from "../helpers.ts";

async function withServer<T>(fn: (x: Extractor) => Promise<T>): Promise<T> {
  const server = new LanguageServer(FIXTURE);
  await server.start();
  try {
    return await fn(new Extractor(server));
  } finally {
    await server.stop();
  }
}

test("records outgoing calls with their call sites", { timeout: 120_000 }, async () => {
  await withServer(async (ex) => {
    const pos = findDef("app.py", "login");
    const login = await ex.prepare("app.py", pos.line, pos.character);
    assert.ok(login, "prepareCallHierarchy resolved login");
    assert.equal(login.name, "login");
    assert.equal(login.file, "app.py");

    const calls = await ex.outgoing(login);
    const names = calls.map((c) => c.to.name).sort();
    assert.ok(names.includes("notify"), `expected notify in ${names.join(",")}`);
    assert.ok(names.includes("create_session"), `expected create_session in ${names.join(",")}`);
    assert.ok(names.includes("audit"), `expected audit in ${names.join(",")}`);

    // Every call carries at least one concrete call-site range.
    for (const c of calls) {
      assert.ok(c.fromRanges.length > 0, `${c.to.name} has a call site`);
    }
  });
});

test("preserves two distinct call sites to the same callee", { timeout: 120_000 }, async () => {
  await withServer(async (ex) => {
    const pos = findDef("app.py", "login");
    const login = await ex.prepare("app.py", pos.line, pos.character);
    assert.ok(login);
    const facts = await ex.traverse(login, { maxDepth: 1 });

    const auditEdges = facts.edges.filter((e) => facts.symbols[e.to]?.name === "audit");
    assert.equal(auditEdges.length, 2, "login calls audit at two distinct sites");
    const lines = auditEdges.map((e) => e.site.range.start.line).sort((a, b) => a - b);
    assert.notEqual(lines[0], lines[1], "the two sites are on different lines");
    const ids = new Set(auditEdges.map((e) => e.id));
    assert.equal(ids.size, 2, "each call site is individually addressable");
  });
});

test("bounds traversal by depth and records the truncated frontier", { timeout: 120_000 }, async () => {
  await withServer(async (ex) => {
    const pos = findDef("app.py", "login");
    const login = await ex.prepare("app.py", pos.line, pos.character);
    assert.ok(login);

    const shallow = await ex.traverse(login, { maxDepth: 1 });
    assert.ok(shallow.truncated.length > 0, "depth 1 truncates the frontier");
    assert.ok(
      !shallow.truncated.includes(shallow.root),
      "the root itself is expanded, not truncated",
    );

    const deep = await ex.traverse(login, { maxDepth: 3 });
    assert.ok(
      Object.keys(deep.symbols).length > Object.keys(shallow.symbols).length,
      "greater depth reaches more symbols",
    );
  });
});

test("terminates on direct recursion and marks the cycle", { timeout: 120_000 }, async () => {
  await withServer(async (ex) => {
    const pos = findDef("app.py", "countdown");
    const countdown = await ex.prepare("app.py", pos.line, pos.character);
    assert.ok(countdown);
    const facts = await ex.traverse(countdown, { maxDepth: 10 });
    assert.ok(facts.cycles.includes(countdown.id), "countdown marked as a cycle");
    const selfEdges = facts.edges.filter((e) => e.from === countdown.id && e.to === countdown.id);
    assert.equal(selfEdges.length, 1);
    assert.equal(selfEdges[0]?.closesCycle, true, "the recursive edge is marked cycle-closing");
  });
});

test("terminates on mutual recursion", { timeout: 120_000 }, async () => {
  await withServer(async (ex) => {
    const pos = findDef("app.py", "ping");
    const ping = await ex.prepare("app.py", pos.line, pos.character);
    assert.ok(ping);
    const facts = await ex.traverse(ping, { maxDepth: 10 });
    assert.ok(facts.cycles.includes(ping.id), "ping is re-reached through pong");
    const back = facts.edges.filter((e) => e.closesCycle);
    assert.ok(back.length >= 1, "the closing edge is recorded, not dropped");
  });
});
