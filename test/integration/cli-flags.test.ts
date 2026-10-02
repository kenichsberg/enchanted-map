import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FIXTURE } from "../helpers.ts";

const TIMEOUT = { timeout: 300_000 };
const CLI = path.resolve(import.meta.dirname, "../../src/cli.ts");

test("a flag that needs a value fails loudly instead of inventing one", TIMEOUT, () => {
  // `--root` with nothing after it became the boolean true, then the string
  // "true", then a directory named `true` beside the current one. Every command
  // then reported an empty project -- truthfully, about a place nobody meant.
  // It reached a registered MCP server before anything noticed.
  const run = (args: string[]) => {
    try {
      return {
        out: execFileSync(process.execPath, [CLI, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
        err: "",
        code: 0,
      };
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string; status?: number };
      return { out: x.stdout ?? "", err: x.stderr ?? "", code: x.status ?? 1 };
    }
  };

  for (const cmd of [
    ["view", "anything", "--root"],
    ["analyze", "anything", "--root"],
    ["check", "--root"],
  ]) {
    const r = run(cmd);
    assert.match(r.err, /--root requires a value/, `${cmd.join(" ")}: ${r.err || r.out}`);
    assert.ok(!`${r.out}${r.err}`.includes("/true"), "and never resolves a directory called true");
  }
});

test("a flag accepts the --key=value form, which cannot lose its value", TIMEOUT, () => {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-flags-"));
  cpSync(FIXTURE, root, { recursive: true });
  // The separated form is what lost its value in the field; this one cannot.
  const out = execFileSync(
    process.execPath,
    [CLI, "declare", "b", "app.py", "broadcast", `--root=${root}`],
    { encoding: "utf8" },
  );
  assert.match(out, /declared 'b'/, out);
  assert.ok(
    existsSync(path.join(root, ".enchanted", "config.yaml")),
    "the value reached the command, and the config landed under it",
  );
});
