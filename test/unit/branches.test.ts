import { test } from "node:test";
import assert from "node:assert/strict";
import { BranchIndex } from "../../src/analysis/branches.ts";
import { FIXTURE } from "../helpers.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(path.join(FIXTURE, "app.py"), "utf8");
const LINES = SRC.split("\n");

/** 0-based line of the first line containing `needle`. */
function lineOf(needle: string): number {
  const i = LINES.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`no line containing ${needle}`);
  return i;
}

function rangeOf(needle: string) {
  const line = lineOf(needle);
  const character = (LINES[line] ?? "").indexOf(needle.trim().split("(")[0] ?? needle);
  return { start: { line, character }, end: { line, character: character + 1 } };
}

test("unguarded call has an empty condition list", async () => {
  const bi = await BranchIndex.create(FIXTURE);
  const conds = bi.conditionsAt("app.py", rangeOf('audit("login", user)'));
  assert.deepEqual(conds, []);
  bi.dispose();
});

test("call in an if branch carries the positive condition", async () => {
  const bi = await BranchIndex.create(FIXTURE);
  const conds = bi.conditionsAt("app.py", rangeOf('notify(SMSSender(), "code")'));
  assert.equal(conds.length, 1);
  assert.equal(conds[0]?.kind, "if_statement");
  assert.equal(conds[0]?.text, "mfa");
  assert.equal(conds[0]?.negated, false);
  bi.dispose();
});

test("call in an else branch carries the negated condition", async () => {
  const bi = await BranchIndex.create(FIXTURE);
  const conds = bi.conditionsAt("app.py", rangeOf("create_session(user)"));
  assert.equal(conds.length, 1);
  assert.equal(conds[0]?.kind, "else_clause");
  assert.equal(conds[0]?.text, "mfa", "else reports the condition it negates");
  assert.equal(conds[0]?.negated, true);
  bi.dispose();
});

test("if and else branches are distinguishable", async () => {
  const bi = await BranchIndex.create(FIXTURE);
  const ifArm = bi.conditionsAt("app.py", rangeOf('notify(SMSSender(), "code")'));
  const elseArm = bi.conditionsAt("app.py", rangeOf("create_session(user)"));
  assert.notDeepEqual(ifArm, elseArm);
  assert.notEqual(ifArm[0]?.negated, elseArm[0]?.negated);
  bi.dispose();
});

test("nested guards are ordered outermost first", async () => {
  const bi = await BranchIndex.create(FIXTURE);
  const conds = bi.conditionsAt("app.py", rangeOf('notify(SMSSender(), "urgent")'));
  assert.equal(conds.length, 2, `expected for+if, got ${JSON.stringify(conds)}`);
  assert.equal(conds[0]?.kind, "for_statement", "outermost first");
  assert.equal(conds[0]?.text, "for user in users");
  assert.equal(conds[1]?.kind, "if_statement");
  assert.equal(conds[1]?.text, "urgent");
  bi.dispose();
});

test("nested else arm keeps the loop guard and negates the inner condition", async () => {
  const bi = await BranchIndex.create(FIXTURE);
  const conds = bi.conditionsAt("app.py", rangeOf('notify(EmailSender(), "normal")'));
  assert.equal(conds.length, 2);
  assert.equal(conds[0]?.kind, "for_statement");
  assert.equal(conds[1]?.kind, "else_clause");
  assert.equal(conds[1]?.negated, true);
  bi.dispose();
});

test("guards stop at the enclosing function", async () => {
  const bi = await BranchIndex.create(FIXTURE);
  const conds = bi.conditionsAt("app.py", rangeOf("countdown(n - 1)"));
  assert.equal(conds.length, 1, "only the guard inside countdown, nothing above it");
  assert.equal(conds[0]?.text, "n > 0");
  bi.dispose();
});
