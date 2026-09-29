import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { JsonRpcClient } from "../../src/lsp/jsonrpc.ts";

const FAKE = path.resolve(import.meta.dirname, "../fixtures/fake-lsp/chatty-server.mjs");

function chatty() {
  const proc = spawn(process.execPath, [FAKE], { stdio: ["pipe", "pipe", "pipe"] });
  return { proc, client: new JsonRpcClient(proc) };
}

test("correlates the response by id, not by arrival order", async () => {
  const { proc, client } = chatty();
  const notes: string[] = [];
  client.onNotification("window/logMessage", () => notes.push("log"));
  client.onServerRequest(() => null);

  const result = (await client.request("initialize", {})) as {
    capabilities: Record<string, unknown>;
  };

  // A notification and a server request arrive BEFORE the response.
  assert.deepEqual(result.capabilities, {
    callHierarchyProvider: true,
    implementationProvider: true,
  });
  assert.equal(notes.length, 1, "notification was dispatched, not swallowed");
  proc.kill();
});

test("answers server-to-client requests", async () => {
  const { proc, client } = chatty();
  const seen: string[] = [];
  client.onServerRequest((method, params) => {
    seen.push(method);
    const items = (params as { items?: unknown[] }).items ?? [];
    return items.map(() => ({}));
  });
  await client.request("initialize", {});
  assert.deepEqual(seen, ["workspace/configuration"]);
  proc.kill();
});

test("reassembles a message split across chunks", async () => {
  const { proc, client } = chatty();
  client.onServerRequest(() => null);
  await client.request("initialize", {});
  // A large payload forces the framing parser across multiple stdout chunks.
  const big = "x".repeat(200_000);
  const echoed = (await client.request("echo", { big })) as { got: { big: string } };
  assert.equal(echoed.got.big.length, 200_000);
  proc.kill();
});

test("rejects pending requests when the server exits", async () => {
  const { proc, client } = chatty();
  client.onServerRequest(() => null);
  await client.request("initialize", {});
  const pending = client.request("never/answered", {});
  proc.kill("SIGKILL");
  await assert.rejects(pending, /exited/);
});
