import type { SymbolId } from "../analysis/types.ts";
import type { Flow, FlowEdge, FlowHole } from "./model.ts";

/**
 * The judgment layer: what an agent decided, on what evidence, and whether that
 * evidence still holds.
 *
 * Everything here is pure. Reading a stored judgment, deciding whether it is
 * still good, and applying it to a flow are separate from writing one, and
 * writing one only ever happens in response to an explicit request.
 */

/**
 * How sure the decision was.
 *
 * A coarse tier rather than a number. A number invites `0.85`, which reads as a
 * measurement and is a feeling; three words cannot be read as more precise than
 * they are. The design left this open; this is the answer, and it is cheap to
 * revisit because nothing computes with it.
 */
export type Confidence = "certain" | "likely" | "guess";

export const CONFIDENCE_LEVELS: readonly Confidence[] = ["certain", "likely", "guess"];

export function isConfidence(v: unknown): v is Confidence {
  return typeof v === "string" && (CONFIDENCE_LEVELS as readonly string[]).includes(v);
}

/**
 * Declining is an outcome, not an absence.
 *
 * Without it, "not yet asked" and "asked and unanswerable" are the same state:
 * the agent re-asks every session, and the genuinely ambiguous holes -- the
 * interesting ones -- are indistinguishable from neglect (design D3).
 */
export type JudgmentOutcome = "resolved" | "declined";

export interface DispatchJudgment {
  outcome: JudgmentOutcome;
  /** The chosen implementation. Null for a decline. */
  target: SymbolId | null;
  /** Who recorded it. `unknown` for a value read from the pre-provenance form. */
  by: string;
  /** ISO timestamp, or empty when the stored form did not carry one. */
  at: string;
  confidence: Confidence | null;
  /** Why this one, or why not at all. */
  note: string | null;
  /**
   * Hash of the hole this answered: declared target plus candidate set. Null
   * when read from a form that predates provenance, which makes it stale on
   * first check rather than trusted (design D7).
   */
  depHash: string | null;
}

/** `current` resolves its edge. Nothing else does. */
export type JudgmentState =
  /** The inputs are unchanged and the decision is well-formed. */
  | "current"
  /** The inputs moved, so the question is open again. */
  | "stale"
  /** Well-formed inputs, but the target is not one of the candidates. */
  | "invalid";

/**
 * Read a stored judgment, accepting the bare-string form written before
 * judgments carried provenance.
 *
 * Discarding the old form would cost a user their curation, which is the one
 * part of a flow file that cannot be regenerated. Reading it costs this
 * function (design D7).
 */
export function readDispatchJudgment(raw: unknown): DispatchJudgment | null {
  if (typeof raw === "string") {
    if (!raw) return null;
    return {
      outcome: "resolved",
      target: raw,
      by: "unknown",
      at: "",
      confidence: null,
      note: null,
      depHash: null,
    };
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const target = typeof r["target"] === "string" && r["target"] ? r["target"] : null;
  const outcome: JudgmentOutcome =
    r["outcome"] === "declined" || (r["outcome"] === undefined && target === null)
      ? "declined"
      : "resolved";
  return {
    outcome,
    target: outcome === "declined" ? null : target,
    by: typeof r["by"] === "string" ? r["by"] : "unknown",
    at: typeof r["at"] === "string" ? r["at"] : "",
    confidence: isConfidence(r["confidence"]) ? r["confidence"] : null,
    note: typeof r["note"] === "string" ? r["note"] : null,
    depHash: typeof r["depHash"] === "string" ? r["depHash"] : null,
  };
}

/**
 * Whether a judgment still answers the hole in front of it.
 *
 * The hash covers the declared target and the candidate set -- what the
 * decision was *about*. A new implementor changes it and reopens the question;
 * an unrelated edit in the calling function does not (design D4).
 */
export function judgmentState(j: DispatchJudgment, hole: FlowHole): JudgmentState {
  // Stale is checked first on purpose: when the candidate set has moved, a
  // target that is no longer among the candidates is expected, and `stale` is
  // the honest word for it. `invalid` is reserved for a hand-edited file whose
  // inputs match but whose answer was never offered.
  if (!j.depHash || j.depHash !== hole.depHash) return "stale";
  if (j.outcome === "declined") return "current";
  if (!j.target || !hole.candidates.includes(j.target)) return "invalid";
  return "current";
}

/** A judgment paired with the hole it answers, and what it is worth right now. */
export interface AppliedJudgment {
  holeId: string;
  siteId: string;
  state: JudgmentState;
  judgment: DispatchJudgment;
  /** The symbol the language server resolved, before any judgment. */
  declaredTarget: SymbolId;
  candidates: SymbolId[];
}

export interface CuratedFlow {
  /** The flow with current resolutions applied. Never the stored object. */
  flow: Flow;
  /** Every judgment that matched a hole, whatever its state. */
  applied: AppliedJudgment[];
  /** Judgment keys naming a call site this flow no longer has. */
  orphaned: string[];
}

/**
 * Derive the curated flow from the stored facts plus the stored judgments.
 *
 * This is deliberately a derivation rather than an edit. The stored flow keeps
 * its holes and its declared targets, so withdrawing a judgment restores the
 * hole exactly -- there is nothing to reconstruct, because nothing was
 * destroyed.
 *
 * A judgment is consulted only where the deterministic layer left a hole, so a
 * resolution the constructor-evidence heuristic already made is never
 * overridden by one (design D6).
 */
export function curate(flow: Flow): CuratedFlow {
  const raw = flow.judgments?.dispatch ?? {};
  const holesBySite = new Map(flow.holes.map((h) => [h.siteId, h]));
  const applied: AppliedJudgment[] = [];
  const orphaned: string[] = [];
  /** siteId -> chosen target, for the resolutions that are actually good. */
  const resolutions = new Map<string, SymbolId>();

  for (const [siteId, stored] of Object.entries(raw)) {
    const judgment = readDispatchJudgment(stored);
    if (!judgment) continue;
    const hole = holesBySite.get(siteId);
    if (!hole) {
      orphaned.push(siteId);
      continue;
    }
    const state = judgmentState(judgment, hole);
    applied.push({
      holeId: hole.id,
      siteId,
      state,
      judgment,
      declaredTarget: hole.declaredTarget,
      candidates: hole.candidates,
    });
    if (state === "current" && judgment.outcome === "resolved" && judgment.target) {
      resolutions.set(siteId, judgment.target);
    }
  }

  if (resolutions.size === 0) return { flow, applied, orphaned };

  const edges: FlowEdge[] = flow.edges.map((e) => {
    const chosen = resolutions.get(e.id);
    if (!chosen) return e;
    return {
      ...e,
      // The edge id keeps the declared target, exactly as it does when the
      // heuristic resolves one: rewriting it would make a curated edge look
      // like a different edge to every consumer, staleness included.
      declaredTarget: e.declaredTarget ?? e.to,
      to: chosen,
      provenance: "agent-inferred",
    };
  });

  return {
    flow: {
      ...flow,
      edges,
      holes: flow.holes.filter((h) => !resolutions.has(h.siteId)),
    },
    applied,
    orphaned,
  };
}

// --------------------------------------------------------------- writing ----

/** Raised where the request names something the flow does not have. */
export class CurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurationError";
  }
}

export interface RecordOptions {
  by?: string;
  note?: string | null;
  confidence?: Confidence | null;
  at?: Date;
}

function holeById(flow: Flow, holeId: string): FlowHole {
  const hole = flow.holes.find((h) => h.id === holeId || h.siteId === holeId);
  if (hole) return hole;
  const known = flow.holes.map((h) => h.id);
  throw new CurationError(
    known.length === 0
      ? `flow '${flow.name}' has no unresolved dispatch '${holeId}'`
      : `flow '${flow.name}' has no hole '${holeId}'. Open holes: ${known.join(", ")}`,
  );
}

function withJudgment(flow: Flow, siteId: string, j: DispatchJudgment | null): Flow {
  const dispatch = { ...flow.judgments.dispatch };
  if (j === null) delete dispatch[siteId];
  else dispatch[siteId] = j;
  return { ...flow, judgments: { ...flow.judgments, dispatch } };
}

/**
 * Record a resolution by the candidate's position in the hole's list.
 *
 * Taking a position rather than a symbol id is what makes a hallucinated target
 * unrepresentable instead of merely detectable: there is no string here to get
 * wrong (design D2).
 */
export function recordResolution(
  flow: Flow,
  holeId: string,
  candidateIndex: number,
  opts: RecordOptions = {},
): { flow: Flow; judgment: DispatchJudgment; hole: FlowHole } {
  const hole = holeById(flow, holeId);
  const target = hole.candidates[candidateIndex];
  if (!Number.isInteger(candidateIndex) || target === undefined) {
    throw new CurationError(
      `candidate ${candidateIndex} is outside hole '${hole.id}', which has ` +
        `${hole.candidates.length} candidates: ` +
        hole.candidates.map((c, i) => `${i}=${c}`).join(", "),
    );
  }
  const judgment: DispatchJudgment = {
    outcome: "resolved",
    target,
    by: opts.by ?? "agent",
    at: (opts.at ?? new Date()).toISOString(),
    confidence: opts.confidence ?? null,
    note: opts.note ?? null,
    depHash: hole.depHash,
  };
  return { flow: withJudgment(flow, hole.siteId, judgment), judgment, hole };
}

/** Record that the hole was considered and could not be answered. */
export function recordDecline(
  flow: Flow,
  holeId: string,
  reason: string,
  opts: RecordOptions = {},
): { flow: Flow; judgment: DispatchJudgment; hole: FlowHole } {
  const hole = holeById(flow, holeId);
  if (!reason.trim()) {
    throw new CurationError("a decline must carry a reason; that is the whole point of it");
  }
  const judgment: DispatchJudgment = {
    outcome: "declined",
    target: null,
    by: opts.by ?? "agent",
    at: (opts.at ?? new Date()).toISOString(),
    confidence: opts.confidence ?? null,
    note: reason,
    depHash: hole.depHash,
  };
  return { flow: withJudgment(flow, hole.siteId, judgment), judgment, hole };
}

/** Remove a judgment, returning the hole to its unresolved state. */
export function withdrawJudgment(flow: Flow, holeId: string): { flow: Flow; siteId: string } {
  const siteId = flow.holes.find((h) => h.id === holeId)?.siteId ?? holeId;
  if (!(siteId in flow.judgments.dispatch)) {
    throw new CurationError(`no judgment recorded for '${holeId}' in flow '${flow.name}'`);
  }
  return { flow: withJudgment(flow, siteId, null), siteId };
}

// --------------------------------------------------------------- offering ---

/** A hole as offered to an agent: the question, and whether it is already answered. */
export interface HoleOffer {
  id: string;
  siteId: string;
  declaredTarget: SymbolId;
  reason: string;
  /** Candidates in the order a resolution indexes into. */
  candidates: Array<{ index: number; id: SymbolId; file: string; line: number; name: string }>;
  /** Where the dispatching call is written. */
  site: { file: string; line: number } | null;
  /** The caller the dispatch happens in. */
  caller: SymbolId | null;
  /** `null` when never offered; otherwise what was decided and whether it holds. */
  judgment:
    | null
    | (DispatchJudgment & { state: JudgmentState });
}

/**
 * Every hole in a flow, each carrying its own answer if it has one.
 *
 * Open and settled holes are returned together rather than filtered, so an
 * agent can see that a question was considered -- and a declined hole does not
 * read as an untouched one (design D3).
 */
export function holeOffers(flow: Flow): HoleOffer[] {
  const { applied } = curate(flow);
  const byHole = new Map(applied.map((a) => [a.holeId, a]));
  const nodeAt = (id: SymbolId) => flow.nodes.find((n) => n.id === id) ?? null;
  const edgeAt = (id: string) => flow.edges.find((e) => e.id === id) ?? null;

  return flow.holes.map((h) => {
    const a = byHole.get(h.id);
    const edge = edgeAt(h.siteId);
    return {
      id: h.id,
      siteId: h.siteId,
      declaredTarget: h.declaredTarget,
      reason: h.reason,
      // Stable because the stored candidate list is itself sorted, and the
      // index an agent answers with means nothing unless this order holds.
      candidates: h.candidates.map((c, index) => {
        const n = nodeAt(c);
        return {
          index,
          id: c,
          file: n?.file ?? c.split("#")[0] ?? "",
          line: n?.line ?? 0,
          name: n?.qualifiedName ?? n?.name ?? (c.split("#")[1] ?? c),
        };
      }),
      site: edge ? { file: edge.file, line: edge.line } : null,
      caller: edge?.from ?? null,
      judgment: a ? { ...a.judgment, state: a.state } : null,
    };
  });
}
