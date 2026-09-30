import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { flowView } from "../../src/views/index.ts";
import type { FlowView } from "../../src/views/index.ts";
import { renderFlow, layout } from "../../src/sidecar/render.mjs";
import type { Flow } from "../../src/flow/model.ts";
import { FIXTURE } from "../helpers.ts";

async function flowOf(symbol: string): Promise<Flow> {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-vp-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: symbol, file: "app.py", symbol });
  return new FlowService(root).analyze(symbol);
}

const idOf = (v: FlowView, label: string) => v.nodes.find((n) => n.label === label)?.id;

test("the initial viewBox is the whole graph, not a crop", { timeout: 300_000 }, async () => {
  const svg = renderFlow(flowView(await flowOf("login"))) as string;
  const m = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  assert.ok(m, "a viewBox is emitted");
  const gw = svg.match(/data-graph-width="(\d+(?:\.\d+)?)"/);
  const gh = svg.match(/data-graph-height="(\d+(?:\.\d+)?)"/);
  assert.ok(gw && gh, "the graph's own size is published for fit and zoom level");
  assert.equal(m[1], gw[1], "the viewBox starts fitted to the graph width");
  assert.equal(m[2], gh[1], "and to its height");
});

test("the svg scales to its container rather than a fixed size", { timeout: 300_000 }, async () => {
  const svg = renderFlow(flowView(await flowOf("login"))) as string;
  const tag = svg.slice(0, svg.indexOf(">") + 1);
  assert.ok(!/\swidth="\d/.test(tag), `no fixed pixel width: ${tag}`);
  assert.match(tag, /preserveAspectRatio/, "it is fitted, not stretched");
});

test("nodes carry an id so they can be focused", { timeout: 300_000 }, async () => {
  const v = flowView(await flowOf("login"));
  const svg = renderFlow(v) as string;
  const notify = idOf(v, "notify");
  assert.ok(notify);
  assert.ok(svg.includes(`data-id="${notify}"`), "the node addresses itself");
  // …and still carries its jump target, so focus did not displace it.
  assert.match(svg, /data-file="app\.py"/);
});

test("a focused view draws only its own nodes", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login");
  const plain = flowView(flow);
  const notify = idOf(plain, "notify");
  assert.ok(notify);

  const focused = flowView(flow, null, { focus: notify });
  const svg = renderFlow(focused) as string;

  const session = idOf(plain, "create_session");
  assert.ok(session);
  assert.ok(!svg.includes(`data-id="${session}"`), "the other arm is not drawn");
  assert.ok(svg.includes(`data-id="${notify}"`), "the focused node is");
});

test("a focused view reports the path back", { timeout: 300_000 }, async () => {
  const flow = await flowOf("login");
  const plain = flowView(flow);
  const notify = idOf(plain, "notify");
  assert.ok(notify);
  const focused = flowView(flow, null, { focus: notify });

  assert.ok(focused.path.length >= 2);
  assert.equal(focused.path[0]?.id, flow.root);
  assert.equal(focused.path[focused.path.length - 1]?.id, notify);
  assert.equal(focused.entryPoint, flow.root, "the entry point is still addressable");
});

test("zoom state appears in no view object", { timeout: 300_000 }, async () => {
  const v = flowView(await flowOf("login"));
  const json = JSON.stringify(v);
  for (const leaked of ["viewBox", "zoom", "pan", "scale"]) {
    assert.ok(!json.includes(leaked), `${leaked} must not reach the view`);
  }
});

test("zoom state appears in no stored flow", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-vp2-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const svc = new FlowService(root);
  await svc.refresh("login");
  const text = readFileSync(path.join(root, ".enchanted", "flows", "login.yaml"), "utf8");
  for (const leaked of ["viewBox", "zoom", "pan:", "focus"]) {
    assert.ok(!text.includes(leaked), `${leaked} must not be stored`);
  }
});

test("the page offers zoom controls and keyboard handling", () => {
  const html = readFileSync(
    path.resolve(import.meta.dirname, "../../src/sidecar/canvas.html"),
    "utf8",
  );
  for (const id of ["zin", "zout", "zfit", "zreset", "zlevel", "crumb"]) {
    assert.ok(html.includes(`id="${id}"`), `control ${id} is present`);
  }
  assert.match(html, /keydown/, "keyboard handling exists");
  assert.match(html, /aria-label="Zoom out"/, "controls are labelled");
  assert.match(html, /wheel/, "wheel zoom");
  assert.match(html, /pointerdown/, "drag to pan");
});

test("the sidecar honours a focus parameter", { timeout: 300_000 }, async () => {
  const { Sidecar } = await import("../../src/sidecar/server.ts");
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-vp3-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const sidecar = new Sidecar(root);

  const whole = (await sidecar.handle("view", { flow: "login" })) as FlowView;
  const notify = whole.nodes.find((n) => n.label === "notify")?.id;
  assert.ok(notify);
  assert.equal(whole.focus, null, "unfocused by default");

  const focused = (await sidecar.handle("view", {
    flow: "login",
    focus: notify,
  })) as FlowView;
  assert.equal(focused.focus, notify, "the parameter reached flowView");
  assert.equal(focused.root, notify);
  assert.ok(focused.counts.nodes < whole.counts.nodes, "and actually narrowed the view");
  assert.ok(focused.path.length >= 2, "with a path back");
});

test("every node but the root carries a visible focus control", { timeout: 300_000 }, async () => {
  const v = flowView(await flowOf("login"));
  const svg = renderFlow(v) as string;

  // Only nodes drawn as boxes get a control. A docked argument renders as a
  // row inside its consuming node and is a leaf by construction, so focusing
  // it would show nothing but itself.
  const esc = (t: string) =>
    t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

  const { nodes: drawn } = layout(v);
  const focusable = [...drawn.values()].filter((n) => n.id !== v.root && !n.external);
  assert.ok(focusable.length > 0);
  for (const n of focusable) {
    assert.ok(
      svg.includes(`data-focus-id="${esc(n.id)}"`),
      `${n.label} needs a control, not only a double-click gesture`,
    );
  }
  assert.ok(!svg.includes(`data-focus-id="${esc(v.root)}"`), "the root has nothing to focus to");
  for (const n of [...drawn.values()].filter((x) => x.external)) {
    assert.ok(
      !svg.includes(`data-focus-id="${esc(n.id)}"`),
      "an external node is never expanded, so focusing it would show only itself",
    );
  }
  assert.match(svg, /aria-label="Focus /, "the control is labelled");
});

test("the height chain is definite so the svg can fill it", () => {
  const html = readFileSync(
    path.resolve(import.meta.dirname, "../../src/sidecar/canvas.html"),
    "utf8",
  );
  assert.match(html, /html,\s*body\s*\{[^}]*height:\s*100%/, "a definite root height");
  assert.ok(
    !/body\s*\{[^}]*min-height:\s*100vh/.test(html),
    "min-height leaves main indefinite and the svg collapses",
  );
  assert.match(html, /main\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(html, /main\s*\{[^}]*min-height:\s*0/);
});

test("the focus control is a thumbtack, not a crosshair or a map pin", { timeout: 300_000 }, async () => {
  const svg = renderFlow(flowView(await flowOf("login"))) as string;
  assert.match(svg, /class="pin"/, "the tack's cap and collar");
  assert.match(svg, /class="pinneedle"/, "and its needle");
  assert.ok(
    !/class="pin" d="M[\d.]+,[\d.]+ C/.test(svg),
    "not the teardrop of a map pin, which means a place rather than pinning one",
  );
  assert.match(svg, /<title>Pin [^<]*: show only what it reaches<\/title>/, "labelled as a pin");
  assert.ok(
    !/M\d+(\.\d+)?,\d+(\.\d+)? L\d+(\.\d+)?,\d+(\.\d+)? M/.test(svg),
    "the crosshair path is gone",
  );
});

test("the container scrolls, so the viewer gets real scrollbars", () => {
  const html = readFileSync(
    path.resolve(import.meta.dirname, "../../src/sidecar/canvas.html"),
    "utf8",
  );
  // Comments describe the bug being avoided, so they mention the very pattern
  // this asserts is absent. Strip them before matching.
  const css = html.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /main\s*\{[^}]*overflow:\s*auto/, "the container scrolls natively");
  assert.ok(
    !/\bsvg\s*\{[^}]*height:\s*100%/.test(css),
    "the svg is sized to the graph, not to the container",
  );
  assert.match(html, /out\.scrollLeft/, "panning moves the scroll position");
});

test("the default zoom is legible rather than fitted", () => {
  const html = readFileSync(
    path.resolve(import.meta.dirname, "../../src/sidecar/canvas.html"),
    "utf8",
  );
  // attach() sets a 1:1 scale and centres; fit is a control, not the default.
  assert.match(html, /scale = 1;\s*\n\s*apply\(\);\s*\n\s*centreOnRoot\(\)/);
  assert.match(html, /centreOnRoot/, "the entry point is where the eye starts");
});

test("a spinner covers the fetch", () => {
  const html = readFileSync(
    path.resolve(import.meta.dirname, "../../src/sidecar/canvas.html"),
    "utf8",
  );
  assert.match(html, /id="spinner"/);
  assert.match(html, /busy\(true/, "shown before the request");
  assert.match(html, /finally\s*\{\s*\n\s*busy\(false\)/, "and always cleared");
  assert.match(html, /prefers-reduced-motion/, "the animation respects the preference");
});
