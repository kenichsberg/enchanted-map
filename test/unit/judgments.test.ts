import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readDispatchJudgment,
  judgmentState,
  curate,
  recordResolution,
  recordDecline,
  withdrawJudgment,
  holeOffers,
  CurationError,
  type DispatchJudgment,
} from "../../src/flow/judgments.ts";
import { depHashes, emptyJudgments, type Flow, type FlowEdge, type FlowHole } from "../../src/flow/model.ts";

// A flow small enough to reason about: one dispatching call with two
// candidates, and one ordinary call that no judgment may ever touch.
const DECLARED = "senders.py#Sender.send";
const SMS = "senders.py#SMSSender.send";
const EMAIL = "senders.py#EmailSender.send";
const SITE = "app.py#notify->senders.py#Sender.send#0";

function hole(candidates = [EMAIL, SMS]): FlowHole {
  const sorted = [...candidates].sort();
  return {
    id: `hole:${SITE}`,
    siteId: SITE,
    declaredTarget: DECLARED,
    reason: "dispatch-candidates",
    candidates: sorted,
    depHash: depHashes.hole(DECLARED, sorted),
  };
}

function edge(id: string, from: string, to: string, provenance = "lsp-verified"): FlowEdge {
  return {
    id,
    from,
    to,
    file: "app.py",
    line: 7,
    character: 4,
    conditions: [],
    ordinal: 0,
    kind: "call",
    enclosingSite: null,
    provenance,
    declaredTarget: null,
    candidates: [],
    closesCycle: false,
    depHash: "edgehash",
  };
}

function flowWith(h: FlowHole, dispatch: Record<string, unknown> = {}): Flow {
  return {
    name: "demo",
    entryPoint: { file: "app.py", symbol: "notify" },
    maxDepth: 3,
    root: "app.py#notify",
    nodes: [DECLARED, SMS, EMAIL, "app.py#notify"].map((id) => ({
      id,
      name: id.split("#")[1] ?? id,
      qualifiedName: id.split("#")[1] ?? id,
      file: id.split("#")[0] ?? "",
      line: 1,
      kind: 12,
      external: false,
      bodyHash: "b",
      depHash: "d",
    })),
    edges: [
      { ...edge(SITE, "app.py#notify", DECLARED, "declared-unresolved"), candidates: h.candidates },
      edge("app.py#notify->app.py#audit#0", "app.py#notify", "app.py#audit"),
    ],
    holes: [h],
    truncated: [],
    external: [],
    cycles: [],
    judgments: {
      ...emptyJudgments(),
      // Deliberately untyped: these tests feed the stored forms, including the
      // bare-target one a pre-provenance flow file carries.
      dispatch: dispatch as unknown as Flow["judgments"]["dispatch"],
    },
    accepted: null,
    broken: false,
    legacy: false,
  };
}

// ------------------------------------------------------------- the shape ----

test("a stored judgment carries its decision and its provenance", () => {
  const { flow, judgment } = recordResolution(flowWith(hole()), `hole:${SITE}`, 1, {
    by: "claude-code",
    note: "the orchestrator constructs the SMS variant",
    confidence: "likely",
    at: new Date("2026-01-02T03:04:05Z"),
  });

  assert.equal(judgment.outcome, "resolved");
  assert.equal(judgment.target, SMS, "index 1 of the sorted candidate list");
  assert.equal(judgment.by, "claude-code");
  assert.equal(judgment.at, "2026-01-02T03:04:05.000Z");
  assert.equal(judgment.confidence, "likely");
  assert.equal(judgment.note, "the orchestrator constructs the SMS variant");
  assert.equal(judgment.depHash, hole().depHash, "the hash of the hole it answered");
  assert.deepEqual(flow.judgments.dispatch[SITE], judgment, "keyed by call site");
});

test("the stored form survives a round trip through JSON", () => {
  const { judgment } = recordResolution(flowWith(hole()), `hole:${SITE}`, 0);
  assert.deepEqual(readDispatchJudgment(JSON.parse(JSON.stringify(judgment))), judgment);
});

// --------------------------------------------------------- the old form ----

test("a bare target reads as a decision of unknown provenance", () => {
  const j = readDispatchJudgment(SMS);
  assert.ok(j);
  assert.equal(j.outcome, "resolved");
  assert.equal(j.target, SMS);
  assert.equal(j.by, "unknown");
  assert.equal(j.depHash, null, "the old form carried no hash");
});

test("a judgment with no hash is stale, not trusted", () => {
  const j = readDispatchJudgment(SMS);
  assert.ok(j);
  assert.equal(judgmentState(j, hole()), "stale");
});

test("an old-form judgment therefore does not resolve its edge", () => {
  const { flow } = curate(flowWith(hole(), { [SITE]: SMS }));
  const e = flow.edges.find((x) => x.id === SITE);
  assert.equal(e?.to, DECLARED, "still pointing at the declared target");
  assert.equal(e?.provenance, "declared-unresolved");
  assert.equal(flow.holes.length, 1, "and the hole is still open");
});

// ------------------------------------------------------------ staleness ----

test("a matching hash is current; a changed candidate set is stale", () => {
  const h = hole();
  const { judgment } = recordResolution(flowWith(h), h.id, 0);
  assert.equal(judgmentState(judgment, h), "current");

  const widened = hole([EMAIL, SMS, "senders.py#FaxSender.send"]);
  assert.equal(
    judgmentState(judgment, widened),
    "stale",
    "a new implementor is exactly the event that reopens the question",
  );
});

test("a target outside the candidate set is invalid, not merely accepted", () => {
  const h = hole();
  const forged: DispatchJudgment = {
    outcome: "resolved",
    target: "senders.py#NotACandidate.send",
    by: "hand-edited yaml",
    at: new Date().toISOString(),
    confidence: "certain",
    note: null,
    // The hash is correct: this is a file edited by hand, not a stale judgment.
    depHash: h.depHash,
  };
  assert.equal(judgmentState(forged, h), "invalid");

  const { flow } = curate(flowWith(h, { [SITE]: forged }));
  assert.equal(
    flow.edges.find((e) => e.id === SITE)?.to,
    DECLARED,
    "an invented target must not reach the map by any path",
  );
  assert.equal(flow.holes.length, 1);
});

// --------------------------------------------------------- the decline ----

test("a decline is its own outcome, distinct from never-asked", () => {
  const { flow, judgment } = recordDecline(
    flowWith(hole()),
    `hole:${SITE}`,
    "both senders are injected at runtime from config",
  );
  assert.equal(judgment.outcome, "declined");
  assert.equal(judgment.target, null);
  assert.equal(judgment.note, "both senders are injected at runtime from config");
  assert.equal(judgment.depHash, hole().depHash, "a decline is memoised like a resolution");

  const offers = holeOffers(flow);
  assert.equal(offers.length, 1, "a declined hole is still listed");
  assert.equal(offers[0]?.judgment?.outcome, "declined");
  assert.equal(offers[0]?.judgment?.state, "current", "so it is not silently re-asked");

  const curated = curate(flow);
  assert.equal(curated.flow.edges.find((e) => e.id === SITE)?.to, DECLARED);
  assert.equal(curated.flow.holes.length, 1, "declining resolves nothing");
});

test("a decline without a reason is refused", () => {
  assert.throws(
    () => recordDecline(flowWith(hole()), `hole:${SITE}`, "   "),
    CurationError,
  );
});

// ------------------------------------------------------------ rejection ----

test("a position outside the candidate list is refused, naming the candidates", () => {
  for (const bad of [2, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => recordResolution(flowWith(hole()), `hole:${SITE}`, bad),
      (e: Error) => {
        assert.ok(e instanceof CurationError);
        assert.match(e.message, /0=.*1=/s, `the valid candidates are named: ${e.message}`);
        return true;
      },
      `index ${bad}`,
    );
  }
});

test("an unknown hole is refused and nothing is stored", () => {
  const before = flowWith(hole());
  assert.throws(() => recordResolution(before, "hole:nonexistent", 0), CurationError);
  assert.deepEqual(before.judgments.dispatch, {}, "the flow is untouched");
});

// ------------------------------------------------------------ withdrawal ----

test("withdrawing restores the hole and the declared target", () => {
  const { flow: judged } = recordResolution(flowWith(hole()), `hole:${SITE}`, 1);
  assert.equal(curate(judged).flow.edges.find((e) => e.id === SITE)?.to, SMS);

  const { flow: withdrawn } = withdrawJudgment(judged, `hole:${SITE}`);
  const curated = curate(withdrawn).flow;
  assert.deepEqual(withdrawn.judgments.dispatch, {});
  assert.equal(curated.edges.find((e) => e.id === SITE)?.to, DECLARED);
  assert.equal(curated.edges.find((e) => e.id === SITE)?.provenance, "declared-unresolved");
  assert.equal(curated.holes.length, 1, "the hole is open again");
});

test("withdrawing something never judged is refused", () => {
  assert.throws(() => withdrawJudgment(flowWith(hole()), `hole:${SITE}`), CurationError);
});

// -------------------------------------------------------------- applying ----

test("a current resolution rewrites the edge and retires the hole", () => {
  const { flow: judged } = recordResolution(flowWith(hole()), `hole:${SITE}`, 1, {
    confidence: "certain",
  });
  const { flow, applied } = curate(judged);

  const e = flow.edges.find((x) => x.id === SITE);
  assert.equal(e?.to, SMS);
  assert.equal(e?.provenance, "agent-inferred");
  assert.equal(e?.declaredTarget, DECLARED, "what the language server said is retained");
  assert.deepEqual(e?.candidates, hole().candidates, "and so is the set it chose from");
  assert.equal(e?.id, SITE, "the edge id does not move; only its target does");
  assert.equal(flow.holes.length, 0, "the hole leaves the list");
  assert.equal(applied[0]?.state, "current");
});

test("curating does not mutate the stored flow", () => {
  const { flow: judged } = recordResolution(flowWith(hole()), `hole:${SITE}`, 1);
  const snapshot = JSON.parse(JSON.stringify(judged));
  curate(judged);
  assert.deepEqual(JSON.parse(JSON.stringify(judged)), snapshot);
});

test("a deterministic resolution is never overridden", () => {
  // The heuristic resolved this site, so it is not a hole. A judgment naming
  // the same site has nothing to attach to and must change nothing.
  const base = flowWith(hole());
  const resolvedByHeuristic: Flow = {
    ...base,
    holes: [],
    edges: base.edges.map((e) =>
      e.id === SITE ? { ...e, to: EMAIL, declaredTarget: DECLARED, provenance: "heuristic" } : e,
    ),
    judgments: {
      ...base.judgments,
      dispatch: { [SITE]: SMS } as unknown as Flow["judgments"]["dispatch"],
    },
  };

  const { flow, orphaned } = curate(resolvedByHeuristic);
  const e = flow.edges.find((x) => x.id === SITE);
  assert.equal(e?.to, EMAIL, "the certain answer stands");
  assert.equal(e?.provenance, "heuristic");
  assert.deepEqual(orphaned, [SITE], "and the judgment is reported as answering nothing");
});

test("an ordinary call is never touched by curation", () => {
  const { flow: judged } = recordResolution(flowWith(hole()), `hole:${SITE}`, 1);
  const plain = curate(judged).flow.edges.find((e) => e.id.endsWith("app.py#audit#0"));
  assert.equal(plain?.provenance, "lsp-verified");
  assert.equal(plain?.to, "app.py#audit");
});

// --------------------------------------------------------------- offers ----

test("a hole is offered with indexed candidates in a stable order", () => {
  const flow = flowWith(hole());
  const first = holeOffers(flow);
  const second = holeOffers(flow);
  assert.deepEqual(
    first.map((h) => h.candidates.map((c) => c.id)),
    second.map((h) => h.candidates.map((c) => c.id)),
    "an index means nothing unless the order holds",
  );
  assert.deepEqual(
    first[0]?.candidates.map((c) => c.index),
    [0, 1],
  );
  assert.equal(first[0]?.judgment, null, "never offered reads as no judgment at all");
  assert.equal(first[0]?.caller, "app.py#notify");
  assert.deepEqual(first[0]?.site, { file: "app.py", line: 7 });
});

test("a judged hole is distinguishable from an open one", () => {
  const { flow } = recordResolution(flowWith(hole()), `hole:${SITE}`, 0);
  const offer = holeOffers(flow)[0];
  assert.equal(offer?.judgment?.state, "current");
  assert.equal(offer?.judgment?.target, EMAIL);
});
