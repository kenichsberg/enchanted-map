import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LanguageServer } from "../../src/lsp/server.ts";
import { Extractor } from "../../src/analysis/extract.ts";
import { FactCache } from "../../src/cache/store.ts";
import { FIXTURE, findDef } from "../helpers.ts";

/** A throwaway copy of the fixture so edits do not touch the repo. */
function scratchFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-cache-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

async function run(root: string, cache: FactCache, depth = 2) {
  const server = new LanguageServer(root);
  await server.start();
  try {
    const ex = new Extractor(server).withCache(cache);
    const pos = findDef("app.py", "login");
    const root_ = await ex.prepare("app.py", pos.line, pos.character);
    if (!root_) throw new Error("no root");
    const facts = await ex.traverse(root_, { maxDepth: depth });
    return { facts, calls: server.requestCounts.get("callHierarchy/outgoingCalls") ?? 0 };
  } finally {
    await server.stop();
  }
}

test("unchanged content is served from cache with no LSP traffic", { timeout: 240_000 }, async () => {
  const root = scratchFixture();
  const cache = new FactCache(root);

  const first = await run(root, cache);
  assert.ok(first.calls > 0, "the first run queries the language server");

  cache.invalidateFileHashes();
  const second = await run(root, cache);
  assert.equal(second.calls, 0, "the second run issues no call-hierarchy requests");
  assert.equal(
    second.facts.edges.length,
    first.facts.edges.length,
    "cached facts match the freshly computed ones",
  );
});

test("editing a file invalidates only the entries that depend on it", { timeout: 240_000 }, async () => {
  const root = scratchFixture();
  const cache = new FactCache(root);
  const cold = await run(root, cache);

  // Touch senders.py. From `login` at depth 2 the only symbol living there is
  // Sender.send, so exactly one entry should need recomputing -- not all of
  // them, and not none.
  const sendersPath = path.join(root, "senders.py");
  writeFileSync(sendersPath, readFileSync(sendersPath, "utf8") + "\n# edited\n");
  cache.invalidateFileHashes();

  const after = await run(root, cache);
  assert.equal(after.calls, 1, "only the symbol defined in the edited file is re-analyzed");
  assert.ok(after.calls < cold.calls, `scoped: ${after.calls} vs cold ${cold.calls}`);

  // A second run with nothing changed goes back to zero.
  cache.invalidateFileHashes();
  const settled = await run(root, cache);
  assert.equal(settled.calls, 0, "re-analysis result is itself cached");

  // Changing app.py invalidates the entries defined there.
  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace('audit("login", user)', 'audit("login2", user)'),
  );
  cache.invalidateFileHashes();
  const changed = await run(root, cache);
  assert.ok(changed.calls > 0, "changed file triggers re-analysis");
});

test("cache lives outside version control", { timeout: 240_000 }, async () => {
  const root = scratchFixture();
  const cache = new FactCache(root);
  await run(root, cache);
  assert.ok(existsSync(cache.dir), "cache directory was created");
  assert.match(cache.dir, /\.enchanted[/\\]cache$/);
  const ignore = readFileSync(
    path.resolve(import.meta.dirname, "../../.gitignore"),
    "utf8",
  );
  assert.match(ignore, /\.enchanted\/cache\//, "the cache path is gitignored");
});

test("traversal does not build a whole-repository graph", { timeout: 240_000 }, async () => {
  const root = scratchFixture();
  const cache = new FactCache(root);
  const { facts } = await run(root, cache, 1);
  // `broadcast`, `ambiguous`, `ping`, `pong` are in the same file but are not
  // reachable from `login`; a repo-wide graph would have pulled them in.
  const names = Object.values(facts.symbols).map((s) => s.name);
  for (const unreachable of ["broadcast", "ambiguous", "ping", "pong", "countdown"]) {
    assert.ok(!names.includes(unreachable), `${unreachable} is not reachable from login`);
  }
});
