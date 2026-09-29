import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { canonical } from "../../src/util/paths.ts";
import { FIXTURE } from "../helpers.ts";

/**
 * A project reached through a symlink used to break completely: the root and
 * the language server's paths disagreed, `path.relative` produced `../..`, and
 * every project file was classified as external. The flow collapsed to stubs.
 *
 * macOS `/tmp` -> `/private/tmp` makes this the default for anything under
 * TMPDIR, but a symlinked checkout does it anywhere.
 */

function project(): { real: string; link: string } {
  const base = mkdtempSync(path.join(tmpdir(), "enchanted-link-"));
  const real = path.join(base, "real");
  cpSync(FIXTURE, real, { recursive: true });
  const link = path.join(base, "via-link");
  symlinkSync(real, link, "dir");
  return { real, link };
}

test("canonical() resolves a symlinked directory", () => {
  const { real, link } = project();
  assert.equal(canonical(link), realpathSync.native(real));
  assert.equal(canonical(link), canonical(real));
});

test("canonical() tolerates a path that does not exist yet", () => {
  const missing = path.join(tmpdir(), "enchanted-not-created-yet", "nested");
  assert.equal(canonical(missing), path.resolve(missing));
});

test("a project reached through a symlink is not classified as external", { timeout: 300_000 }, async () => {
  const { link } = project();
  declareEntryPoint(link, { name: "broadcast", file: "app.py", symbol: "broadcast" });
  const flow = await new FlowService(link).analyze("broadcast");

  const internal = flow.nodes.filter((n) => !n.external);
  assert.ok(internal.length > 1, `expected project nodes, got ${flow.nodes.length} all-external`);

  // The project's own files must never carry an external label.
  for (const n of flow.nodes) {
    if (n.file.endsWith("app.py") || n.file.endsWith("senders.py")) {
      assert.ok(!n.external, `${n.id} is project code, not external`);
      assert.ok(!n.id.startsWith("<ext>/"), `${n.id} must not be labelled external`);
    }
  }
  assert.ok(
    flow.nodes.some((n) => n.file === "senders.py"),
    `senders.py should be a plain relative path: ${flow.nodes.map((n) => n.file).join(", ")}`,
  );
});

test("the same project analyzed via both paths produces the same flow", { timeout: 300_000 }, async () => {
  const { real, link } = project();
  declareEntryPoint(real, { name: "login", file: "app.py", symbol: "login" });

  const viaReal = await new FlowService(real).analyze("login");
  const viaLink = await new FlowService(link).analyze("login");

  assert.deepEqual(
    viaLink.nodes.map((n) => n.id).sort(),
    viaReal.nodes.map((n) => n.id).sort(),
    "node identity must not depend on how the root was spelled",
  );
  assert.deepEqual(
    viaLink.edges.map((e) => e.id).sort(),
    viaReal.edges.map((e) => e.id).sort(),
  );
  assert.deepEqual(
    viaLink.nodes.map((n) => n.depHash).sort(),
    viaReal.nodes.map((n) => n.depHash).sort(),
    "hashes must match, or staleness fires spuriously on a symlinked checkout",
  );
});

test("staleness is clean across the two spellings of the root", { timeout: 300_000 }, async () => {
  const { real, link } = project();
  declareEntryPoint(real, { name: "login", file: "app.py", symbol: "login" });

  const svc = new FlowService(real);
  await svc.refresh("login"); // store via the real path

  // Read it back via the symlink: nothing changed, so nothing is stale.
  const status = await new FlowService(link).status("login");
  assert.equal(status.error, null, String(status.error));
  assert.equal(
    status.report?.stale,
    false,
    `spurious staleness: ${JSON.stringify(status.report?.entries.slice(0, 5), null, 2)}`,
  );
});
