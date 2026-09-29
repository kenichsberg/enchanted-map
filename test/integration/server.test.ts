import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  LanguageServer,
  MissingCapabilityError,
  ServerStartError,
  REQUIRED_CAPABILITIES,
} from "../../src/lsp/server.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/pyproj");
const FAKE_DIR = path.resolve(import.meta.dirname, "../fixtures/fake-lsp");

test("starts basedpyright and exposes the required capabilities", { timeout: 120_000 }, async () => {
  const server = new LanguageServer(FIXTURE);
  await server.start();
  try {
    for (const cap of REQUIRED_CAPABILITIES) {
      assert.ok(server.capabilities[cap], `expected ${cap} to be advertised`);
    }
  } finally {
    await server.stop();
  }
});

test("analysis completes with no editor process running", { timeout: 120_000 }, async () => {
  // The sidecar owns its own language server (design D1); nothing here touches
  // Neovim, and no NVIM socket is inherited from the environment.
  assert.equal(process.env["NVIM"], undefined, "test must not run inside a Neovim session");
  const server = new LanguageServer(FIXTURE);
  await server.start();
  try {
    const uri = server.openDocument("app.py");
    assert.match(uri, /app\.py$/);
    assert.equal(server.openedDocuments.size, 1);
    // A real request must succeed with no editor in the picture.
    const symbols = await server.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    assert.ok(Array.isArray(symbols) && symbols.length > 0, "documentSymbol returned results");
  } finally {
    await server.stop();
  }
});

test("openDocument is idempotent", { timeout: 120_000 }, async () => {
  const server = new LanguageServer(FIXTURE);
  await server.start();
  try {
    server.openDocument("app.py");
    server.openDocument("app.py");
    server.openDocument("senders.py");
    assert.equal(server.openedDocuments.size, 2);
  } finally {
    await server.stop();
  }
});

test("stop() terminates the server process", { timeout: 120_000 }, async () => {
  const server = new LanguageServer(FIXTURE);
  await server.start();
  await server.stop();
  await assert.rejects(
    () => server.request("textDocument/documentSymbol", {}),
    /not started/,
  );
});

test("rejects a server missing implementationProvider", { timeout: 30_000 }, async () => {
  // This is precisely the pyright case: call hierarchy yes, implementation no.
  const cmd = [process.execPath, path.join(FAKE_DIR, "no-caps-server.mjs")];
  const server = new LanguageServer(FIXTURE, cmd);
  await assert.rejects(
    () => server.start(),
    (e: unknown) => {
      assert.ok(e instanceof MissingCapabilityError);
      assert.deepEqual(e.missing, ["implementationProvider"]);
      assert.ok(e.message.includes("no-caps-server.mjs"), "reports the attempted command");
      assert.ok(e.message.includes("basedpyright"), "names the required server");
      return true;
    },
  );
});

test("reports the attempted command when the binary is missing", { timeout: 30_000 }, async () => {
  const server = new LanguageServer(FIXTURE, ["definitely-not-a-real-langserver-xyz", "--stdio"]);
  await assert.rejects(
    () => server.start(),
    (e: unknown) => {
      assert.ok(e instanceof ServerStartError, `expected ServerStartError, got ${String(e)}`);
      assert.ok(e.message.includes("definitely-not-a-real-langserver-xyz"));
      return true;
    },
  );
});
