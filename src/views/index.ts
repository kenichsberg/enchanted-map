import type { CallKind, Condition } from "../analysis/types.ts";
import type { Flow, FlowEdge, FlowNode } from "../flow/model.ts";
import type { StalenessReport } from "../flow/staleness.ts";
import { acceptanceState, type AcceptanceState } from "../flow/staleness.ts";

/**
 * Views are plain serialisable objects. Nothing here imports an editor, a
 * browser, or a rendering library: the editor, the canvas, and CI all consume
 * the same output (design D13).
 */

/**
 * Guards that say something about *whether* a call runs.
 *
 * A `context` guard's body always runs, so rendering it as a condition asserts
 * a choice that does not exist -- and buries the guards that do (design D3).
 */
const LABELLED_CATEGORIES = new Set(["branch", "loop"]);

export function conditionLabel(conditions: Condition[]): string {
  const selecting = conditions.filter((c) =>
    LABELLED_CATEGORIES.has(c.category ?? "branch"),
  );
  if (selecting.length === 0) return "";
  return selecting
    .map((c) => {
      const body = c.text ?? c.kind.replace(/_/g, " ");
      return c.negated ? `!${body}` : body;
    })
    .join(" && ");
}

export interface ViewNode {
  id: string;
  label: string;
  qualifiedName: string;
  file: string;
  line: number;
  external: boolean;
  /** Not expanded because the depth bound was reached. */
  truncated: boolean;
  /** Reached again while already on the traversal path. */
  cycle: boolean;
  stale: boolean;
  staleReasons: string[];
}

export interface ViewEdge {
  id: string;
  from: string;
  to: string;
  /** Rendered guard, e.g. `for user in users && !urgent`. Empty when unguarded. */
  conditionLabel: string;
  conditions: Condition[];
  provenance: string;
  /** True when the concrete target is unknown. */
  unresolved: boolean;
  candidates: string[];
  declaredTarget: string | null;
  closesCycle: boolean;
  stale: boolean;
  staleReasons: string[];
  file: string;
  line: number;
  /** Position among the caller's calls, in source order. */
  ordinal: number;
  kind: CallKind;
  /** For an `argument`, the id of the edge whose call it feeds. */
  enclosingSite: string | null;
  /**
   * How deeply this call is nested in argument positions. 0 is statement level.
   * A surface can indent by this without walking the chain itself.
   */
  nestingDepth: number;
  /**
   * True when this call is evaluated before the call it feeds. An argument is
   * evaluated before the call that consumes it, which is what makes
   * `notify(SMSSender(), ...)` a sequence rather than two independent calls.
   */
  evaluatedBeforeEnclosing: boolean;
}

/** A step on the path from a flow's entry point to a focused node. */
export interface PathStep {
  id: string;
  label: string;
}

export interface FlowViewOptions {
  /** Render only this node and what it reaches (design D1). */
  focus?: string | null;
}

export interface FlowView {
  kind: "flow";
  flow: string;
  /** The focused node when focused, otherwise the flow's entry point. */
  root: string;
  /** The flow's own entry point, unchanged by focus. */
  entryPoint: string;
  /** The focused node, or null. */
  focus: string | null;
  /**
   * Ordered path from the entry point to the focused node, so a surface can
   * offer a way back. Empty when unfocused. It comes from the graph rather
   * than from a viewer's click history, so it survives a reload and is the
   * same on every surface (design D2).
   */
  path: PathStep[];
  maxDepth: number;
  acceptance: AcceptanceState;
  acceptedRevision: string | null;
  broken: boolean;
  nodes: ViewNode[];
  edges: ViewEdge[];
  holes: Array<{ id: string; siteId: string; declaredTarget: string; reason: string; candidates: string[] }>;
  counts: { nodes: number; edges: number; holes: number; stale: number };
}

function staleIndex(report: StalenessReport | null): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const e of report?.entries ?? []) {
    const list = idx.get(e.affects);
    if (list) list.push(e.reason);
    else idx.set(e.affects, [e.reason]);
  }
  return idx;
}

function toViewNode(n: FlowNode, flow: Flow, stale: Map<string, string[]>): ViewNode {
  const reasons = stale.get(n.id) ?? [];
  return {
    id: n.id,
    label: n.name,
    qualifiedName: n.qualifiedName ?? n.name,
    file: n.file,
    line: n.line,
    external: n.external,
    truncated: flow.truncated.includes(n.id),
    cycle: flow.cycles.includes(n.id),
    stale: reasons.length > 0,
    staleReasons: reasons,
  };
}

function toViewEdge(
  e: FlowEdge,
  stale: Map<string, string[]>,
  nestingDepth = 0,
): ViewEdge {
  const reasons = stale.get(e.id) ?? [];
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    conditionLabel: conditionLabel(e.conditions),
    conditions: e.conditions,
    provenance: e.provenance,
    unresolved: e.provenance === "declared-unresolved",
    candidates: e.candidates,
    declaredTarget: e.declaredTarget,
    closesCycle: e.closesCycle,
    stale: reasons.length > 0,
    staleReasons: reasons,
    file: e.file,
    line: e.line,
    ordinal: e.ordinal ?? 0,
    kind: e.kind ?? "call",
    enclosingSite: e.enclosingSite ?? null,
    nestingDepth,
    evaluatedBeforeEnclosing: (e.kind ?? "call") === "argument",
  };
}

/**
 * Order a flow's edges so that a caller's calls appear in source order, and an
 * argument appears directly beneath the call it feeds rather than beside it.
 *
 * Returns each edge with the nesting depth a surface should indent by.
 */
function sequence(edges: FlowEdge[]): Array<{ edge: FlowEdge; depth: number }> {
  const byEnclosing = new Map<string, FlowEdge[]>();
  const roots: FlowEdge[] = [];
  const known = new Set(edges.map((e) => e.id));

  for (const e of edges) {
    const enclosing = e.enclosingSite;
    // An argument whose enclosing call is not in this flow (depth-truncated,
    // for instance) is presented at statement level rather than dropped.
    if (e.kind === "argument" && enclosing && known.has(enclosing)) {
      const list = byEnclosing.get(enclosing);
      if (list) list.push(e);
      else byEnclosing.set(enclosing, [e]);
    } else {
      roots.push(e);
    }
  }

  const bySource = (a: FlowEdge, b: FlowEdge) =>
    a.from === b.from ? (a.ordinal ?? 0) - (b.ordinal ?? 0) : a.from.localeCompare(b.from);

  const out: Array<{ edge: FlowEdge; depth: number }> = [];
  const emit = (edge: FlowEdge, depth: number, seen: Set<string>): void => {
    if (seen.has(edge.id)) return; // defensive: a cycle in enclosing links
    seen.add(edge.id);
    out.push({ edge, depth });
    for (const child of (byEnclosing.get(edge.id) ?? []).sort(bySource)) {
      emit(child, depth + 1, seen);
    }
  };

  const seen = new Set<string>();
  for (const e of [...roots].sort(bySource)) emit(e, 0, seen);
  // Anything unreachable through the tree still appears, so nothing is lost.
  for (const e of edges) if (!seen.has(e.id)) emit(e, 0, seen);
  return out;
}

/**
 * Nodes reachable from `start`, following call edges.
 *
 * A node reachable both from here and from elsewhere is included: the question
 * focus answers is "what does this do", and a helper called from two places is
 * part of what it does (design D3).
 */
function reachableFrom(start: string, edges: FlowEdge[]): Set<string> {
  const outgoing = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const list = outgoing.get(e.from);
    if (list) list.push(e);
    else outgoing.set(e.from, [e]);
  }
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const e of outgoing.get(id) ?? []) {
      // A cycle-closing edge is recorded but not followed, exactly as the
      // traversal that produced it did.
      if (e.closesCycle) continue;
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }

  // A retained edge may name symbols no call reaches: the candidates of an
  // unresolved dispatch, and the declared target a heuristic edge was
  // rewritten from. They are part of what that edge says, so a focused view
  // that dropped them could not render its own holes or provenance. Added
  // without expanding them -- nothing calls them.
  for (const e of edges) {
    if (!seen.has(e.from)) continue;
    if (e.declaredTarget) seen.add(e.declaredTarget);
    for (const c of e.candidates) seen.add(c);
  }
  return seen;
}

/** Shortest path from the entry point to `target`, or empty if unreachable. */
function pathTo(root: string, target: string, edges: FlowEdge[]): string[] {
  if (root === target) return [root];
  const outgoing = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const list = outgoing.get(e.from);
    if (list) list.push(e);
    else outgoing.set(e.from, [e]);
  }
  const prev = new Map<string, string>();
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const e of outgoing.get(id) ?? []) {
      if (e.closesCycle || seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, id);
      if (e.to === target) {
        const out = [target];
        let cur = target;
        while (prev.has(cur)) {
          cur = prev.get(cur) as string;
          out.unshift(cur);
        }
        return out;
      }
      queue.push(e.to);
    }
  }
  return [];
}

/** The whole flow: nodes are functions, guards live on edges (design D4). */
export function flowView(
  flow: Flow,
  report: StalenessReport | null = null,
  opts: FlowViewOptions = {},
): FlowView {
  const stale = staleIndex(report);

  // Focus selects what is shown. It must not change what any of it means, so
  // every mark below is computed exactly as it is for the whole flow.
  const focus = opts.focus && flow.nodes.some((n) => n.id === opts.focus) ? opts.focus : null;
  const keep = focus ? reachableFrom(focus, flow.edges) : null;
  const nodes = keep ? flow.nodes.filter((n) => keep.has(n.id)) : flow.nodes;
  const edges = keep
    ? flow.edges.filter((e) => keep.has(e.from) && keep.has(e.to))
    : flow.edges;
  const holes = keep
    ? flow.holes.filter((h) => edges.some((e) => e.id === h.siteId))
    : flow.holes;
  const labelOf = (id: string) => flow.nodes.find((n) => n.id === id)?.name ?? id;
  const path = focus
    ? pathTo(flow.root, focus, flow.edges).map((id) => ({ id, label: labelOf(id) }))
    : [];

  return {
    kind: "flow",
    flow: flow.name,
    root: focus ?? flow.root,
    entryPoint: flow.root,
    focus,
    path,
    maxDepth: flow.maxDepth,
    acceptance: acceptanceState(flow, report),
    acceptedRevision: flow.accepted?.revision ?? null,
    broken: flow.broken,
    nodes: nodes.map((n) => toViewNode(n, flow, stale)),
    edges: sequence(edges).map(({ edge, depth }) => toViewEdge(edge, stale, depth)),
    holes: holes.map((h) => ({
      id: h.id,
      siteId: h.siteId,
      declaredTarget: h.declaredTarget,
      reason: h.reason,
      candidates: h.candidates,
    })),
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      holes: holes.length,
      stale: report?.entries.length ?? 0,
    },
  };
}

export interface DiffView {
  kind: "diff";
  flow: string;
  against: string;
  addedNodes: ViewNode[];
  removedNodes: ViewNode[];
  addedEdges: ViewEdge[];
  removedEdges: ViewEdge[];
  /** Same edge, different guard. Reported as its own category, not remove+add. */
  conditionChanged: Array<{ edge: ViewEdge; before: string; after: string }>;
  /** Nodes the entry point reaches now but did not before. */
  newlyReachable: ViewNode[];
  empty: boolean;
}

export function diffView(before: Flow, after: Flow, against = "stored"): DiffView {
  const empty = new Map<string, string[]>();
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));

  const addedNodes = after.nodes
    .filter((n) => !beforeNodes.has(n.id))
    .map((n) => toViewNode(n, after, empty));
  const removedNodes = before.nodes
    .filter((n) => !afterNodes.has(n.id))
    .map((n) => toViewNode(n, before, empty));

  const addedEdges: ViewEdge[] = [];
  const conditionChanged: DiffView["conditionChanged"] = [];
  for (const e of after.edges) {
    const prev = beforeEdges.get(e.id);
    if (!prev) {
      addedEdges.push(toViewEdge(e, empty));
      continue;
    }
    const beforeLabel = conditionLabel(prev.conditions);
    const afterLabel = conditionLabel(e.conditions);
    if (beforeLabel !== afterLabel) {
      conditionChanged.push({ edge: toViewEdge(e, empty), before: beforeLabel, after: afterLabel });
    }
  }
  const removedEdges = before.edges
    .filter((e) => !afterEdges.has(e.id))
    .map((e) => toViewEdge(e, empty));

  return {
    kind: "diff",
    flow: after.name,
    against,
    addedNodes,
    removedNodes,
    addedEdges,
    removedEdges,
    conditionChanged,
    newlyReachable: addedNodes,
    empty:
      addedNodes.length === 0 &&
      removedNodes.length === 0 &&
      addedEdges.length === 0 &&
      removedEdges.length === 0 &&
      conditionChanged.length === 0,
  };
}

export interface StalenessView {
  kind: "staleness";
  flow: string;
  stale: boolean;
  entries: Array<{ kind: string; id: string; affects: string; reason: string; label: string }>;
  staleNodeIds: string[];
  staleEdgeIds: string[];
  invalidated: string[];
}

export function stalenessView(flow: Flow, report: StalenessReport): StalenessView {
  const label = (id: string) =>
    flow.nodes.find((n) => n.id === id)?.name ??
    flow.edges.find((e) => e.id === id)?.id ??
    id;
  return {
    kind: "staleness",
    flow: flow.name,
    stale: report.entries.length > 0,
    entries: report.entries.map((e) => ({
      kind: e.kind,
      id: e.id,
      affects: e.affects,
      reason: e.reason,
      label: label(e.affects),
    })),
    staleNodeIds: report.entries.filter((e) => e.kind === "node").map((e) => e.affects),
    staleEdgeIds: report.entries.filter((e) => e.kind === "edge").map((e) => e.affects),
    invalidated: report.invalidated,
  };
}

export interface ProvenanceView {
  kind: "provenance";
  flow: string;
  tiers: Record<string, string[]>;
  unresolved: Array<{ edgeId: string; declaredTarget: string; candidates: string[] }>;
}

export function provenanceView(flow: Flow): ProvenanceView {
  const tiers: Record<string, string[]> = {
    "lsp-verified": [],
    heuristic: [],
    "declared-unresolved": [],
  };
  for (const e of flow.edges) {
    (tiers[e.provenance] ??= []).push(e.id);
  }
  return {
    kind: "provenance",
    flow: flow.name,
    tiers,
    unresolved: flow.edges
      .filter((e) => e.provenance === "declared-unresolved")
      .map((e) => ({ edgeId: e.id, declaredTarget: e.to, candidates: e.candidates })),
  };
}
