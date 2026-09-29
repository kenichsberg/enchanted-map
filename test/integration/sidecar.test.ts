import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sidecar } from "../../src/sidecar/server.ts";
import type { JumpTarget } from "../../src/sidecar/server.ts";
import { FIXTURE } from "../helpers.ts";
import { canonical } from "../../src/util/paths.ts";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "enchanted-sidecar-"));
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

/**
 * Bind a port, or return null when the environment forbids listening.
 * Some sandboxes disallow local binding; the HTTP surface is still worth
 * testing wherever it is permitted.
 */
async function tryListen(sidecar: Sidecar): Promise<number | null> {
  try {
    return await sidecar.listen(0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return null;
    throw e;
  }
}

const NO_BIND = "local port binding is not permitted in this environment";

// ---------------------------------------------------------------- dispatch --

test("dispatch answers the view methods", { timeout: 300_000 }, async () => {
  const root = repo();
  const sidecar = new Sidecar(root);
  await sidecar.handle("declare", { name: "login", file: "app.py", symbol: "login" });
  await sidecar.handle("analyze", { flow: "login" });

  const flow = (await sidecar.handle("view", { flow: "login", lens: "flow" })) as {
    kind: string;
    counts: { nodes: number };
  };
  assert.equal(flow.kind, "flow");
  assert.ok(flow.counts.nodes > 0);

  const prov = (await sidecar.handle("view", { flow: "login", lens: "provenance" })) as {
    kind: string;
  };
  assert.equal(prov.kind, "provenance");

  const { flows } = (await sidecar.handle("flows", {})) as { flows: string[] };
  assert.deepEqual(flows, ["login"]);
});

test("unknown methods and unknown flows raise errors", { timeout: 300_000 }, async () => {
  const root = repo();
  const sidecar = new Sidecar(root);
  await assert.rejects(() => sidecar.handle("nope", {}), /unknown method/);

  // A fresh repo has no entry points, so THAT is the real cause -- not the
  // flow name. Reporting the name here would send the user hunting for a
  // missing analysis instead of a missing declaration.
  await assert.rejects(
    () => sidecar.handle("view", { flow: "missing" }),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /no entry points are declared/, msg);
      assert.ok(msg.includes(root), "the resolved root is named");
      return true;
    },
  );
});

test("a jump notifies the editor listener and carries the root", { timeout: 300_000 }, async () => {
  const root = repo();
  const sidecar = new Sidecar(root);
  const jumps: JumpTarget[] = [];
  sidecar.onJump((t) => jumps.push(t));
  await sidecar.handle("jump", { file: "app.py", line: 18, character: 4 });
  // Without the root the editor must guess which project the file belongs to,
  // and a scratch buffer gives it no way to guess correctly.
  // The sidecar canonicalises its root, so compare against what it resolved.
  assert.deepEqual(jumps, [
    { file: "app.py", line: 18, character: 4, root: sidecar.root },
  ]);
  assert.equal(sidecar.root, canonical(root), "the root is canonical");
});

test("accept is reachable from a surface and persists", { timeout: 300_000 }, async () => {
  const root = repo();
  const sidecar = new Sidecar(root);
  await sidecar.handle("declare", { name: "login", file: "app.py", symbol: "login" });
  await sidecar.handle("analyze", { flow: "login" });
  const view = (await sidecar.handle("accept", { flow: "login" })) as {
    acceptance: string;
    acceptedRevision: string | null;
  };
  assert.equal(view.acceptance, "accepted");
  assert.ok(view.acceptedRevision && view.acceptedRevision !== "unversioned");
  assert.match(
    readFileSync(path.join(root, ".enchanted", "flows", "login.yaml"), "utf8"),
    /accepted:/,
  );
});

test("the view reflects drift after an edit, locally", { timeout: 300_000 }, async () => {
  const root = repo();
  const sidecar = new Sidecar(root);
  await sidecar.handle("declare", { name: "login", file: "app.py", symbol: "login" });
  await sidecar.handle("analyze", { flow: "login" });

  const appPath = path.join(root, "app.py");
  writeFileSync(
    appPath,
    readFileSync(appPath, "utf8").replace(
      "def audit(kind: str, user: str) -> None:\n",
      "def audit(kind: str, user: str) -> None:\n    _drift = 1\n",
    ),
  );

  const view = (await sidecar.handle("view", { flow: "login", lens: "flow" })) as {
    counts: { stale: number };
    nodes: Array<{ stale: boolean }>;
  };
  assert.ok(view.counts.stale > 0, "the view reports drift");
  assert.ok(view.nodes.some((n) => n.stale), "staleness is attributed to nodes");
  assert.ok(view.nodes.some((n) => !n.stale), "the rest of the flow is still readable");
});

// ------------------------------------------------------------ stdio (nvim) --

test("stdio RPC answers the editor without any socket", { timeout: 300_000 }, async () => {
  const root = repo();
  const CLI = path.resolve(import.meta.dirname, "../../src/cli.ts");
  execFileSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "declare", "login", "app.py", "login", "--root", root],
    { stdio: "ignore" },
  );

  const proc = spawn(
    process.execPath,
    ["--experimental-strip-types", CLI, "serve", "--stdio", "--root", root],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  proc.stderr.resume();

  const lines: string[] = [];
  let buf = "";
  proc.stdout.setEncoding("utf8");
  const gotLine = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a reply")), 30_000);
      const onData = (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          lines.push(line);
          clearTimeout(timer);
          proc.stdout.off("data", onData);
          resolve(JSON.parse(line) as Record<string, unknown>);
          return;
        }
      };
      proc.stdout.on("data", onData);
    });

  try {
    // The sidecar announces itself. The editor surface must come up even when
    // the browser surface could not bind a port.
    const first = await gotLine();
    assert.equal(first["event"], "ready");
    const ready = first["params"] as { port: number | null; bindError: string | null };
    if (ready.port === null) {
      assert.ok(ready.bindError, "a failure to bind is reported, not hidden");
    }

    proc.stdin.write(JSON.stringify({ id: 1, method: "ping" }) + "\n");
    const pong = await gotLine();
    assert.equal(pong["id"], 1);
    assert.deepEqual((pong["result"] as { ok: boolean }).ok, true);

    proc.stdin.write(JSON.stringify({ id: 2, method: "flows" }) + "\n");
    const flows = await gotLine();
    assert.deepEqual((flows["result"] as { flows: string[] }).flows, ["login"]);

    proc.stdin.write(JSON.stringify({ id: 3, method: "nope" }) + "\n");
    const err = await gotLine();
    assert.match(String(err["error"]), /unknown method/);
  } finally {
    proc.kill("SIGKILL");
  }
});

// --------------------------------------------------------------- http (web) --

test("browser and editor receive identical view objects", { timeout: 300_000 }, async (t) => {
  const root = repo();
  const sidecar = new Sidecar(root);
  await sidecar.handle("declare", { name: "login", file: "app.py", symbol: "login" });
  await sidecar.handle("analyze", { flow: "login" });
  const viaRpc = await sidecar.handle("view", { flow: "login", lens: "flow" });

  const port = await tryListen(sidecar);
  if (port === null) return t.skip(NO_BIND);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "view", params: { flow: "login", lens: "flow" } }),
    });
    const body = (await res.json()) as { result: unknown };
    assert.deepEqual(body.result, JSON.parse(JSON.stringify(viaRpc)));
  } finally {
    await sidecar.close();
  }
});

test("serves the canvas page", { timeout: 300_000 }, async (t) => {
  const sidecar = new Sidecar(repo());
  const port = await tryListen(sidecar);
  if (port === null) return t.skip(NO_BIND);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /EventSource/, "the page subscribes to live updates");
  } finally {
    await sidecar.close();
  }
});

test("a jump from the browser reaches the editor", { timeout: 300_000 }, async (t) => {
  const sidecar = new Sidecar(repo());
  const jumps: JumpTarget[] = [];
  sidecar.onJump((j) => jumps.push(j));
  const port = await tryListen(sidecar);
  if (port === null) return t.skip(NO_BIND);
  try {
    await fetch(`http://127.0.0.1:${port}/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "jump", params: { file: "app.py", line: 18, character: 4 } }),
    });
    assert.deepEqual(jumps[0], { file: "app.py", line: 18, character: 4, root: sidecar.root });
  } finally {
    await sidecar.close();
  }
});

test("re-analysis pushes an update with no page reload", { timeout: 300_000 }, async (t) => {
  const root = repo();
  const sidecar = new Sidecar(root);
  await sidecar.handle("declare", { name: "login", file: "app.py", symbol: "login" });
  const port = await tryListen(sidecar);
  if (port === null) return t.skip(NO_BIND);
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    const pending = reader.read();
    await sidecar.handle("analyze", { flow: "login" });
    const chunk = await pending;
    assert.match(new TextDecoder().decode(chunk.value), /event: flow/);
    controller.abort();
  } finally {
    await sidecar.close();
  }
});

test("HTTP errors are reported, not silently empty", { timeout: 300_000 }, async (t) => {
  const sidecar = new Sidecar(repo());
  const port = await tryListen(sidecar);
  if (port === null) return t.skip(NO_BIND);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "view", params: { flow: "nope" } }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /nope/);
  } finally {
    await sidecar.close();
  }
});
