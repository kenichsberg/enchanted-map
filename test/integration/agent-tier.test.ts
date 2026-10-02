import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { readFlow } from "../../src/flow/store.ts";
import { flowView, provenanceView } from "../../src/views/index.ts";
import { renderFlow, renderProvenance } from "../../src/sidecar/render.mjs";
import { Sidecar } from "../../src/sidecar/server.ts";
import { FIXTURE } from "../helpers.ts";

const TIMEOUT = { timeout: 300_000 };
const CLI = path.resolve(import.meta.dirname, "../../src/cli.ts");

/** A fixture copy with `broadcast` analyzed and its first hole resolved. */
async function judged(): Promise<{ root: string; siteId: string; chosen: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-tier-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "broadcast", file: "app.py", symbol: "broadcast" });
  const svc = new FlowService(root);
  await svc.refresh("broadcast");
  const hole = svc.holes("broadcast")[0];
  assert.ok(hole, "the fixture has a dispatch hole to judge");
  const { judgment } = svc.resolveDispatch("broadcast", hole.id, 0, {
    by: "test-agent",
    confidence: "guess",
    note: "picked arbitrarily, so the surfaces have something to be honest about",
  });
  assert.ok(judgment.target);
  return { root, siteId: hole.siteId, chosen: judgment.target };
}

// ------------------------------------------------------------- the canvas ---

test("the canvas draws an agent-inferred edge as its own tier", TIMEOUT, async () => {
  const { root, siteId, chosen } = await judged();
  const view = flowView(readFlow(root, "broadcast")!);
  const html = renderFlow(view);

  assert.ok(
    html.includes('class="edge agent-inferred"'),
    "the edge carries the tier as a class, so CSS can give it its own stroke",
  );
  assert.ok(html.includes("var(--agent)"), "and its own colour, distinct from verified");
  assert.ok(
    !html.includes(`class="edge lsp-verified"><title>${siteId}`),
    "it is never drawn as verified",
  );
  assert.ok(
    html.includes("agent-inferred: chosen by test-agent (guess)"),
    "and says so where it is read, not only in the legend",
  );
  assert.ok(html.includes("Agent-inferred (1)"), "with a section listing what was inferred");
  assert.ok(html.includes(chosen), "naming the implementation chosen");
});

test("the canvas stylesheet gives the tier a non-colour difference", TIMEOUT, async () => {
  const css = await import("node:fs").then((fs) =>
    fs.readFileSync(path.resolve(import.meta.dirname, "../../src/sidecar/canvas.html"), "utf8"),
  );
  const rule = /\.edge\.agent-inferred\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the tier has a rule of its own");
  assert.match(rule[1] ?? "", /stroke-dasharray/, "a dash pattern, so hue is not the only signal");
  assert.ok(css.includes("--agent:"), "a token, defined for light and dark");
  assert.ok(css.includes("agent-inferred</span>"), "and a legend entry");
});

test("the provenance lens exposes the decision behind the target", TIMEOUT, async () => {
  const { root, chosen } = await judged();
  const stored = readFlow(root, "broadcast")!;
  const v = provenanceView(stored);

  assert.deepEqual(Object.keys(v.tiers).sort(), [
    "agent-inferred",
    "declared-unresolved",
    "heuristic",
    "lsp-verified",
  ], "every tier is named, including empty ones");
  assert.equal(v.inferred.length, 1);
  assert.equal(v.inferred[0]?.chosen, chosen);
  assert.equal(v.inferred[0]?.confidence, "guess");
  assert.equal(v.inferred[0]?.by, "test-agent");
  assert.ok((v.inferred[0]?.candidates.length ?? 0) >= 2, "with the set it chose from");

  const html = renderProvenance(v);
  assert.ok(html.includes("Agent-inferred (1)"));
  assert.ok(html.includes("guess"), "the confidence is rendered, not swallowed");
});

// --------------------------------------------------------------- the CLI ----

test("the CLI marks a judged edge and counts guesses apart from facts", TIMEOUT, async () => {
  const { root, chosen } = await judged();
  const out = execFileSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "view", "broadcast", "--root", root],
    { encoding: "utf8" },
  );
  assert.match(out, /agent-inferred/, "the tier is shown");
  assert.match(out, /by test-agent\/guess/, "with who decided and how sure");
  assert.match(out, /judgments: 1 standing/, "and counted apart from the facts");

  const prov = execFileSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "view", "broadcast", "--root", root, "--lens", "provenance"],
    { encoding: "utf8" },
  );
  assert.match(prov, /agent-inferred: 1/);
  assert.ok(prov.includes(chosen), "naming what was chosen");
  assert.match(prov, /chosen from \d+/, "and how many it chose between");
});

test("the CLI advertises the agent surface", TIMEOUT, () => {
  const help = execFileSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "help"],
    { encoding: "utf8" },
  );
  assert.match(help, /enchanted-map mcp/);
  assert.match(help, /claude mcp add enchanted-map/, "with the one line that registers it");
});

// ------------------------------------------------------- the other surfaces -

test("a judgment recorded in another process reaches the live surfaces", TIMEOUT, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-live-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "broadcast", file: "app.py", symbol: "broadcast" });
  await new FlowService(root).refresh("broadcast");

  const sidecar = new Sidecar(root);
  const events: Array<{ event: string; data: unknown }> = [];
  sidecar.onEvent((event, data) => events.push({ event, data }));
  // The watcher is what makes this work: Claude Code spawns the MCP server as
  // its own process, so a judgment recorded there cannot be broadcast from
  // inside this one. Watching the stored flows means any writer reaches here.
  sidecar.watchFlows(50);
  try {
    // A separate FlowService, standing in for that process.
    const agent = new FlowService(root);
    const hole = agent.holes("broadcast")[0];
    assert.ok(hole);
    agent.resolveDispatch("broadcast", hole.id, 0, { by: "another-process" });

    await new Promise((r) => setTimeout(r, 400));
    assert.ok(
      events.some((e) => e.event === "flow"),
      `the surfaces are told to re-render without being asked: ${JSON.stringify(events)}`,
    );

    // …and what they then ask for carries the judgment.
    const view = (await sidecar.handle("view", { flow: "broadcast" })) as ReturnType<typeof flowView>;
    assert.equal(view.counts.judged, 1);
    assert.ok(view.edges.some((e) => e.provenance === "agent-inferred"));
  } finally {
    await sidecar.close();
  }
});

test("the surfaces work unchanged with no agent in sight", TIMEOUT, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-noagent-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "broadcast", file: "app.py", symbol: "broadcast" });
  const flow = await new FlowService(root).refresh("broadcast");

  const v = flowView(flow);
  assert.equal(v.counts.judged, 0);
  assert.equal(v.counts.staleJudgments, 0);
  assert.deepEqual(v.judgments, []);
  assert.ok(v.counts.holes > 0, "the holes are simply open");
  assert.ok(v.edges.every((e) => e.judgment === null));
  assert.ok(!renderFlow(v).includes("Agent-inferred"));
  assert.deepEqual(provenanceView(flow).tiers["agent-inferred"], []);
});
