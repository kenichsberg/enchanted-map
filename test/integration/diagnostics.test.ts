import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sidecar } from "../../src/sidecar/server.ts";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { FIXTURE } from "../helpers.ts";

/**
 * A misconfigured root used to surface as "flow 'x' has not been analyzed",
 * which sends the user looking for a missing analysis instead of a wrong
 * directory. These lock in the real cause being reported.
 */

test("an empty root says so, and says where it looked", { timeout: 300_000 }, async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "enchanted-empty-"));
  const sidecar = new Sidecar(empty);
  await assert.rejects(
    () => sidecar.handle("view", { flow: "login" }),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /no entry points are declared/, msg);
      assert.ok(msg.includes(empty), "the resolved root is named");
      assert.match(msg, /enchanted-map declare/, "it says how to fix it");
      return true;
    },
  );
});

test("an unknown flow name lists the ones that do exist", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-known-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });

  await assert.rejects(
    () => new FlowService(root).analyze("logout"),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /no entry point named 'logout'/, msg);
      assert.ok(msg.includes(root), "the resolved root is named");
      assert.match(msg, /Declared entry points: login/, "it lists what is available");
      return true;
    },
  );
});

test("the real cause is not replaced by 'has not been analyzed'", { timeout: 300_000 }, async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "enchanted-cause-"));
  const sidecar = new Sidecar(empty);
  const err = await sidecar.handle("view", { flow: "anything" }).then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(err);
  assert.ok(
    !/has not been analyzed/.test(err.message),
    `the generic message must not mask the cause: ${err.message}`,
  );
});

test("a declared but never-analyzed flow still analyzes on demand", { timeout: 300_000 }, async () => {
  // The genuine "not analyzed yet" case must keep working: view falls back to
  // analyzing from source rather than demanding a stored file first.
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-fresh-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "login", file: "app.py", symbol: "login" });
  const view = (await new Sidecar(root).handle("view", { flow: "login" })) as {
    kind: string;
    counts: { nodes: number };
  };
  assert.equal(view.kind, "flow");
  assert.ok(view.counts.nodes > 0, "it analyzed without a stored flow file");
});
