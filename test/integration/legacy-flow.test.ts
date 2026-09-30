import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Sidecar } from "../../src/sidecar/server.ts";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { readFlow, writeFlow, flowPath } from "../../src/flow/store.ts";
import { FIXTURE } from "../helpers.ts";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-legacy-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Strip the fields a pre-ordering version would not have written. */
function downgrade(root: string, name: string): void {
  const file = flowPath(root, name);
  const raw = YAML.parse(readFileSync(file, "utf8")) as { edges: Record<string, unknown>[] };
  for (const e of raw.edges) {
    delete e["ordinal"];
    delete e["kind"];
    delete e["enclosingSite"];
  }
  writeFileSync(file, YAML.stringify(raw, { lineWidth: 0 }), "utf8");
}

test("a stored flow missing the new fields is marked legacy", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  await new FlowService(root).refresh("login");
  assert.equal(readFlow(root, "login")?.legacy, false, "a freshly written flow is not legacy");

  downgrade(root, "login");
  assert.equal(readFlow(root, "login")?.legacy, true, "a downgraded flow is detected");
});

test("the view does not present a legacy flow as current", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const svc = new FlowService(root);
  const flow = await svc.refresh("login");
  flow.judgments.labels[flow.root] = "kept through re-analysis";
  writeFlow(root, flow);
  downgrade(root, "login");

  // This is the exact failure that made the canvas look unchanged: defaulted
  // fields render every call as an unordered sibling.
  const view = (await new Sidecar(root).handle("view", { flow: "login" })) as {
    edges: Array<{ kind: string; ordinal: number; nestingDepth: number; to: string }>;
    nodes: Array<{ id: string; label: string }>;
  };

  const args = view.edges.filter((e) => e.kind === "argument");
  assert.ok(args.length > 0, "nesting is present, not defaulted away");
  assert.ok(args.every((a) => a.nestingDepth >= 1));

  const ordinals = view.edges.map((e) => e.ordinal);
  assert.ok(new Set(ordinals).size > 1, "ordinals are real, not all zero");

  const label = (id: string) => view.nodes.find((n) => n.id === id)?.label ?? id;
  const sms = view.edges.find((e) => label(e.to) === "SMSSender");
  const notify = view.edges.find((e) => label(e.to) === "notify");
  assert.ok(sms && notify);
  assert.equal(
    view.edges.indexOf(sms),
    view.edges.indexOf(notify) + 1,
    "SMSSender is beneath notify, not beside it",
  );
});

test("a current stored flow is still the one presented", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const svc = new FlowService(root);
  const flow = await svc.refresh("login");
  svc.accept("login");

  const view = (await new Sidecar(root).handle("view", { flow: "login" })) as {
    acceptance: string;
  };
  // Acceptance lives on the stored flow; seeing it proves the stored one was
  // used rather than being bypassed whenever a fresh analysis exists.
  assert.equal(view.acceptance, "accepted");
  assert.equal(flow.legacy, false);
});
