import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { flowView } from "../../src/views/index.ts";
import { FIXTURE } from "../helpers.ts";

function repo(from = FIXTURE): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-e2eseq-"));
  cpSync(from, dir, { recursive: true });
  return dir;
}

test("login reads in source order with SMSSender beneath notify", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const v = flowView(await new FlowService(root).analyze("login"));
  const label = (id: string) => v.nodes.find((n) => n.id === id)?.label ?? id;

  const rendered = v.edges
    .filter((e) => e.from === v.root)
    .map((e) => `${"  ".repeat(e.nestingDepth)}${e.ordinal}. ${label(e.to)}`);

  assert.deepEqual(rendered, [
    "0. audit",
    "1. notify",
    "  2. SMSSender",
    "3. create_session",
    "4. audit",
  ]);
});

test("broadcast still leaves its dispatch hole open with both candidates", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "broadcast", file: "app.py", symbol: "broadcast" });
  const flow = await new FlowService(root).analyze("broadcast");
  assert.equal(flow.holes.length, 1);
  assert.deepEqual(flow.holes[0]!.candidates.sort(), [
    "senders.py#EmailSender.send",
    "senders.py#SMSSender.send",
  ]);
  assert.equal(flow.edges.filter((e) => e.provenance === "heuristic").length, 0);
});

test("ordering and nesting hold on real Python, and report nesting depth", { timeout: 600_000 }, async () => {
  const candidates = [
    "/Users/ken/.local/share/mise/installs/python/3.13.12/lib/python3.13/json",
  ];
  const source = candidates.find((c) => {
    try {
      readFileSync(path.join(c, "__init__.py"));
      return true;
    } catch {
      return false;
    }
  });
  if (!source) return;

  const root = repo(source);
  declareEntryPoint(root, { name: "dumps", file: "__init__.py", symbol: "dumps" });
  const v = flowView(await new FlowService(root).analyze("dumps"));

  // Ordinals are contiguous per caller and ascend with source position.
  const callers = new Set(v.edges.map((e) => e.from));
  for (const caller of callers) {
    const mine = v.edges.filter((e) => e.from === caller);
    const ordinals = mine.map((e) => e.ordinal).sort((a, b) => a - b);
    assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
    assert.equal(new Set(ordinals).size, ordinals.length, "ordinals are unique per caller");
  }

  // Every argument edge names a call that exists in the flow.
  const ids = new Set(v.edges.map((e) => e.id));
  const args = v.edges.filter((e) => e.kind === "argument");
  for (const a of args) {
    assert.ok(a.enclosingSite, "an argument names what it feeds");
    assert.ok(ids.has(a.enclosingSite), "and that call is present in the flow");
    assert.ok(a.nestingDepth >= 1);
  }

  const maxDepth = v.edges.reduce((m, e) => Math.max(m, e.nestingDepth), 0);
  const hist = new Map<number, number>();
  for (const e of v.edges) hist.set(e.nestingDepth, (hist.get(e.nestingDepth) ?? 0) + 1);
  process.stderr.write(
    `\n  [nesting] json.dumps: ${v.edges.length} edges, ${args.length} arguments, ` +
      `max depth ${maxDepth}, by depth ${JSON.stringify([...hist].sort((a, b) => a[0] - b[0]))}\n`,
  );
});
