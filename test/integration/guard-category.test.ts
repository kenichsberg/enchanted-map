import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BranchIndex } from "../../src/analysis/branches.ts";
import { FlowService } from "../../src/flow/service.ts";
import { declareEntryPoint } from "../../src/flow/config.ts";
import { flowView, conditionLabel } from "../../src/views/index.ts";
import { depHashes } from "../../src/flow/model.ts";
import type { Condition } from "../../src/analysis/types.ts";
import { FIXTURE } from "../helpers.ts";
import { readFileSync } from "node:fs";

const SRC = readFileSync(path.join(FIXTURE, "app.py"), "utf8").split("\n");

/** `create_session(user)` appears three times, so occurrences are addressable. */
function rangeOf(needle: string, occurrence = 0) {
  let seen = 0;
  for (let line = 0; line < SRC.length; line++) {
    if (!(SRC[line] ?? "").includes(needle)) continue;
    if (seen++ < occurrence) continue;
    const character = (SRC[line] ?? "").indexOf(needle.trim().split("(")[0] ?? needle);
    return { start: { line, character }, end: { line, character: character + 1 } };
  }
  throw new Error(`no line ${occurrence} containing ${needle}`);
}

async function guardsAt(needle: string, occurrence = 0): Promise<Condition[]> {
  const bi = await BranchIndex.create(FIXTURE);
  const conds = bi.conditionsAt("app.py", rangeOf(needle, occurrence));
  bi.dispose();
  return conds;
}

// create_session(user): 0 = login's else arm, 1 = inside with_structured's if,
// 2 = inside with_try's except.
const IN_WITH_IF = 1;
const IN_EXCEPT = 2;

// ------------------------------------------------------------- categories --

test("a selecting construct is a branch", async () => {
  const ifArm = await guardsAt('notify(SMSSender(), "code")');
  assert.equal(ifArm[0]?.kind, "if_statement");
  assert.equal(ifArm[0]?.category, "branch");

  const elseArm = await guardsAt("create_session(user)");
  assert.equal(elseArm[0]?.kind, "else_clause");
  assert.equal(elseArm[0]?.category, "branch");
});

test("except is a branch: its body runs only when the error is raised", async () => {
  const conds = await guardsAt("create_session(user)", IN_EXCEPT);
  const except = conds.find((c) => c.kind === "except_clause");
  assert.ok(except, `expected an except guard, got ${JSON.stringify(conds)}`);
  assert.equal(except.category, "branch", "an except selects a path (design D2)");
});

test("a repeating construct is a loop", async () => {
  const conds = await guardsAt('notify(SMSSender(), "urgent")');
  const forGuard = conds.find((c) => c.kind === "for_statement");
  assert.ok(forGuard, "the loop guard is collected");
  assert.equal(forGuard.category, "loop");
});

test("a construct whose body always runs is context", async () => {
  const conds = await guardsAt('audit("load", user)');
  assert.equal(conds.length, 1, "the with is collected");
  assert.equal(conds[0]?.kind, "with_statement");
  assert.equal(conds[0]?.category, "context");
});

test("context guards are still collected, not discarded", async () => {
  const conds = await guardsAt('audit("load", user)');
  assert.ok(conds.length > 0, "nothing is dropped at extraction time");
  assert.equal(conditionLabel(conds), "", "…it is simply not rendered as a condition");
});

// ------------------------------------------------------------ the label ----

test("a call guarded only by with has an empty label", async () => {
  assert.equal(conditionLabel(await guardsAt('audit("load", user)')), "");
});

test("an if inside a with labels with the if alone", async () => {
  const conds = await guardsAt("create_session(user)", IN_WITH_IF);
  assert.deepEqual(
    conds.map((c) => `${c.kind}:${c.category}`),
    ["with_statement:context", "if_statement:branch"],
    "both guards are collected, outermost first",
  );
  assert.equal(conditionLabel(conds), "user", "only the selecting one labels");
});

test("finally does not label; except does", async () => {
  const fin = await guardsAt('audit("done", user)');
  assert.equal(fin[0]?.kind, "finally_clause");
  assert.equal(fin[0]?.category, "context");
  assert.equal(conditionLabel(fin), "", "finally always runs, so it is not a condition");

  assert.equal(
    conditionLabel(await guardsAt("create_session(user)", IN_EXCEPT)),
    "ValueError",
    "except selects, so it labels",
  );
});

test("existing labels are unchanged", async () => {
  assert.equal(conditionLabel(await guardsAt('notify(SMSSender(), "code")')), "mfa");
  assert.equal(conditionLabel(await guardsAt('notify(SMSSender(), "urgent")')), "for user in users && urgent");
  assert.equal(conditionLabel(await guardsAt('notify(EmailSender(), "normal")')), "for user in users && !urgent");
});

// ------------------------------------------------------------- hashing ----

test("a context guard does not enter the edge hash; a branch guard does", () => {
  const base = { kind: "x", text: "cond", negated: false, line: 1 } as const;
  const withBranch = depHashes.edge("call()", [{ ...base, category: "branch" }], "call", null);
  const withContext = depHashes.edge("call()", [{ ...base, category: "context" }], "call", null);
  const unguarded = depHashes.edge("call()", [], "call", null);

  assert.equal(withContext, unguarded, "a context guard leaves the hash where it was");
  assert.notEqual(withBranch, unguarded, "a selecting guard changes it");
});

test("adding a with around a call does not churn its hash", () => {
  const ifGuard = { kind: "if_statement", category: "branch", text: "flag", negated: false, line: 1 } as const;
  const withGuard = { kind: "with_statement", category: "context", text: "_Step(\"x\")", negated: false, line: 0 } as const;

  assert.equal(
    depHashes.edge("call()", [ifGuard], "call", null),
    depHashes.edge("call()", [withGuard, ifGuard], "call", null),
    "wrapping in a with leaves the label, and so the hash, unchanged",
  );
});

// ------------------------------------------------- end to end on a flow ----

test("a with-structured flow reads without context guard text", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-guard-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "structured", file: "app.py", symbol: "with_structured" });
  const v = flowView(await new FlowService(root).analyze("structured"));

  const label = (id: string) => v.nodes.find((n) => n.id === id)?.label ?? id;
  for (const e of v.edges) {
    assert.ok(
      !e.conditionLabel.includes("_Step"),
      `${label(e.to)} must not be labelled with the with expression: ${e.conditionLabel}`,
    );
  }
  const session = v.edges.find((e) => label(e.to) === "create_session");
  assert.ok(session, "the guarded call is present");
  assert.equal(session.conditionLabel, "user", "the if inside the with survives alone");

  const audits = v.edges.filter((e) => label(e.to) === "audit");
  assert.ok(audits.length > 0);
  assert.ok(
    audits.every((e) => e.conditionLabel === ""),
    "calls guarded only by a with are unguarded as far as the label is concerned",
  );
});

test("a try/except flow labels the except arm and not the finally", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "enchanted-guard2-"));
  cpSync(FIXTURE, root, { recursive: true });
  declareEntryPoint(root, { name: "trying", file: "app.py", symbol: "with_try" });
  const v = flowView(await new FlowService(root).analyze("trying"));
  const label = (id: string) => v.nodes.find((n) => n.id === id)?.label ?? id;

  const excepted = v.edges.find((e) => label(e.to) === "create_session");
  assert.ok(excepted, "the except arm is present");
  assert.equal(excepted.conditionLabel, "ValueError", "except is a branch and labels");

  const audits = v.edges.filter((e) => label(e.to) === "audit");
  assert.ok(
    audits.some((e) => e.conditionLabel === ""),
    "the finally call carries no condition",
  );
});
