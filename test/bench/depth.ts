// Depth sweep on real Python, to answer whether depth 3 is a sane default.
// Run: node --experimental-strip-types test/bench/depth.ts
import { mkdtempSync, cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowAnalyzer } from "../../src/flow/analyze.ts";
import { FactCache } from "../../src/cache/store.ts";

const SOURCES = [
  { name: "json", dir: "/Users/ken/.local/share/mise/installs/python/3.13.12/lib/python3.13/json", file: "__init__.py", symbol: "dumps" },
  { name: "argparse", dir: "/Users/ken/.local/share/mise/installs/python/3.13.12/lib/python3.13", file: "argparse.py", symbol: "ArgumentParser" },
];

function repo(from: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-bench-"));
  cpSync(from, dir, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "t@e.com"], ["config", "user.name", "T"], ["add", "-A"], ["commit", "-q", "-m", "i"]]) {
    try {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    } catch {
      /* large trees may exceed limits; git is not required for the sweep */
    }
  }
  return dir;
}

console.log("source      depth   ms   nodes  internal  edges  guarded  holes  truncated");
console.log("-".repeat(78));

for (const src of SOURCES) {
  if (!existsSync(path.join(src.dir, src.file))) {
    console.log(`${src.name}: not present, skipped`);
    continue;
  }
  const root = repo(src.dir);
  for (const depth of [2, 3, 4, 5]) {
    // Cold cache each time, so the number is analysis cost and not cache cost.
    const cache = new FactCache(root, path.join(tmpdir(), `bench-cache-${src.name}-${depth}-${Date.now()}`));
    const t0 = Date.now();
    let flow;
    try {
      flow = await new FlowAnalyzer(root, { maxDepth: depth, cache }).analyze({
        name: src.symbol,
        file: src.file,
        symbol: src.symbol,
      });
    } catch (e) {
      console.log(`${src.name.padEnd(11)} ${String(depth).padEnd(6)} error: ${(e as Error).message}`);
      continue;
    }
    const ms = Date.now() - t0;
    const internal = flow.nodes.filter((n) => !n.external).length;
    const guarded = flow.edges.filter((e) => e.conditions.length > 0).length;
    console.log(
      [
        src.name.padEnd(11),
        String(depth).padEnd(6),
        String(ms).padStart(5),
        String(flow.nodes.length).padStart(6),
        String(internal).padStart(9),
        String(flow.edges.length).padStart(7),
        String(guarded).padStart(8),
        String(flow.holes.length).padStart(6),
        String(flow.truncated.length).padStart(10),
      ].join(""),
    );
  }
}
