import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint, loadConfig, saveConfig } from "../../src/flow/config.ts";
import { writeFlow, flowPath } from "../../src/flow/store.ts";
import { flowView } from "../../src/views/index.ts";
import type { Flow } from "../../src/flow/model.ts";

/**
 * A project with a dependency installed inside its own directory -- the
 * ordinary Python arrangement, and the one the original "does the path escape
 * the root" test got wrong.
 */
function vendoredProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-vendored-"));
  const site = path.join(root, ".venv", "lib", "python3.13", "site-packages", "vendorlib");
  mkdirSync(site, { recursive: true });

  writeFileSync(
    path.join(site, "__init__.py"),
    [
      "def helper(value: str) -> str:",
      "    return _inner(value)",
      "",
      "",
      "def _inner(value: str) -> str:",
      "    return _deeper(value)",
      "",
      "",
      "def _deeper(value: str) -> str:",
      "    return value.upper()",
      "",
    ].join("\n"),
  );

  // A project file whose NAME contains a marker as a substring. It must stay
  // project code; a substring test would wrongly exclude it.
  writeFileSync(
    path.join(root, "my_venv_helpers.py"),
    "def tidy(value: str) -> str:\n    return value.strip()\n",
  );

  writeFileSync(
    path.join(root, "app.py"),
    [
      "import vendorlib",
      "from my_venv_helpers import tidy",
      "",
      "",
      "def main(value: str) -> str:",
      "    cleaned = tidy(value)",
      "    return vendorlib.helper(cleaned)",
      "",
    ].join("\n"),
  );

  writeFileSync(
    path.join(root, "pyrightconfig.json"),
    JSON.stringify({ venvPath: ".", venv: ".venv", typeCheckingMode: "basic" }, null, 2),
  );

  declareEntryPoint(root, { name: "main", file: "app.py", symbol: "main" });
  return root;
}

const named = (flow: Flow, n: string) => flow.nodes.filter((x) => x.name === n);

test("a dependency inside the project directory is not traversed", { timeout: 300_000 }, async () => {
  const root = vendoredProject();
  const flow = await new FlowService(root).analyze("main");

  const helper = named(flow, "helper")[0];
  assert.ok(helper, "the call into the dependency is still recorded");
  assert.ok(helper.external, "…and marked external");

  // Its own calls must not appear: _inner and _deeper are library internals.
  assert.equal(named(flow, "_inner").length, 0, "the dependency was not expanded");
  assert.equal(named(flow, "_deeper").length, 0);
  assert.ok(
    !flow.edges.some((e) => e.from === helper.id),
    "no edge leaves the vendored symbol",
  );
});

test("a vendored symbol is external, not truncated by depth", { timeout: 300_000 }, async () => {
  const root = vendoredProject();
  const flow = await new FlowService(root).analyze("main");
  const helper = named(flow, "helper")[0];
  assert.ok(helper);

  assert.ok(flow.external.includes(helper.id), "listed as external");
  assert.ok(!flow.truncated.includes(helper.id), "not reported as cut off by the depth bound");

  const view = flowView(flow);
  const node = view.nodes.find((n) => n.id === helper.id);
  assert.equal(node?.external, true);
  assert.equal(node?.truncated, false);
});

test("project code whose name merely contains a marker is still expanded", { timeout: 300_000 }, async () => {
  const root = vendoredProject();
  const flow = await new FlowService(root).analyze("main");

  const tidy = named(flow, "tidy")[0];
  assert.ok(tidy, "the project helper is reached");
  assert.equal(tidy.external, false, "my_venv_helpers.py is project code");
  assert.equal(tidy.file, "my_venv_helpers.py", "and keeps its real path");
});

test("a stored vendored location carries no interpreter version", { timeout: 300_000 }, async () => {
  const root = vendoredProject();
  const flow = await new FlowService(root).analyze("main");
  writeFlow(root, flow);
  const text = readFileSync(flowPath(root, "main"), "utf8");

  assert.match(text, /<ext>\/vendorlib/, "labelled from the dependency's own path");
  assert.ok(!text.includes("python3.13"), "no interpreter version");
  assert.ok(!text.includes(".venv"), "nothing above the marker");
  assert.ok(!text.includes("site-packages"), "nor the marker itself");
});

test("replacing the defaults lets a dependency back in", { timeout: 300_000 }, async () => {
  const root = vendoredProject();
  // Only node_modules counts now, so the Python venv is treated as source.
  const config = loadConfig(root);
  saveConfig(root, { ...config, vendor: { replace: ["node_modules"] } });

  const flow = await new FlowService(root).analyze("main");
  const helper = named(flow, "helper")[0];
  assert.ok(helper);
  assert.equal(helper.external, false, "no longer excluded");
  assert.ok(named(flow, "_inner").length > 0, "and its internals are now traversed");
});

test("the vendor setting round-trips through config", { timeout: 300_000 }, async () => {
  const root = vendoredProject();
  const before = loadConfig(root);
  saveConfig(root, { ...before, vendor: { extend: ["thirdparty"], replace: [".venv"] } });

  const after = loadConfig(root);
  assert.deepEqual(after.vendor, { extend: ["thirdparty"], replace: [".venv"] });
  assert.equal(after.entryPoints.length, before.entryPoints.length, "entry points survive");
});

test("no vendor setting means the defaults apply", { timeout: 300_000 }, async () => {
  const root = vendoredProject();
  assert.equal(loadConfig(root).vendor, undefined, "absent by default");
  const flow = await new FlowService(root).analyze("main");
  assert.ok(named(flow, "helper")[0]?.external, "and the defaults exclude the venv");
});
