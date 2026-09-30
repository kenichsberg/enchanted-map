import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { writeFlow } from "../../src/flow/store.ts";
import { flowView } from "../../src/views/index.ts";
import {
  DEFAULT_VENDOR_MARKERS,
  externalLabel,
  isExternal,
} from "../../src/analysis/vendor.ts";
import { FIXTURE } from "../helpers.ts";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-ext-"));
  cpSync(FIXTURE, dir, { recursive: true });
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@e.com"],
    ["config", "user.name", "T"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init"],
  ]) {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

test("a call into the standard library is recorded but not followed", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const flow = await new FlowService(root).analyze("login");

  // `audit` calls print(); the call must be visible.
  const externals = flow.nodes.filter((n) => n.external);
  assert.ok(externals.length > 0, "the stdlib target is recorded");
  assert.ok(externals.some((n) => n.name === "print"), `got ${externals.map((n) => n.name).join(",")}`);
  assert.ok(
    flow.edges.some((e) => externals.some((x) => x.id === e.to)),
    "the edge into the standard library is present",
  );

  // …and nothing was traversed out of it.
  for (const ext of externals) {
    assert.ok(
      !flow.edges.some((e) => e.from === ext.id),
      `${ext.name} was not expanded`,
    );
    assert.ok(flow.external.includes(ext.id), "it is listed as external");
  }
});

test("external symbols are distinguishable from depth-truncated ones", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const flow = await new FlowService(root).analyze("login");
  const view = flowView(flow);

  // The two reasons a node is not expanded are reported separately.
  assert.ok(flow.external.length > 0, "some nodes are external");
  for (const id of flow.external) {
    assert.ok(!flow.truncated.includes(id), `${id} is external, not truncated`);
  }
  const extNodes = view.nodes.filter((n) => n.external);
  assert.ok(extNodes.length > 0);
  assert.ok(extNodes.every((n) => !n.truncated), "the view keeps the two states distinct");
});

test("external locations are portable across checkouts", { timeout: 300_000 }, async () => {
  const root = repo();
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const flow = await new FlowService(root).analyze("login");
  writeFlow(root, flow);

  const text = readFileSync(path.join(root, ".enchanted", "flows", "login.yaml"), "utf8");
  assert.ok(!text.includes(process.env["HOME"] ?? "\u0000"), "no home directory");
  assert.ok(!text.includes("node_modules/"), "no installation path");
  assert.ok(!/\.\.\//.test(text), "no path escaping the project root");
  assert.match(text, /<ext>\//, "external symbols carry a portable label");
});

test("the external label is derived, not machine-specific", () => {
  const M = DEFAULT_VENDOR_MARKERS;
  assert.equal(
    externalLabel("../../../some/where/node_modules/basedpyright/x/builtins.pyi", M),
    "<ext>/basedpyright/x/builtins.pyi",
  );
  assert.equal(externalLabel("../../elsewhere/foo.py", M), "<ext>/foo.py");
  assert.ok(isExternal("../outside.py", M));
  assert.ok(!isExternal("inside/app.py", M));
});
