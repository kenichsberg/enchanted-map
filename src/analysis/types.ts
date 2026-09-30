import type { Range } from "../lsp/server.ts";

export type { Range, Position, Location } from "../lsp/server.ts";

/**
 * Identifier for a symbol: `<repo-relative file>#<dotted qualified name>`.
 *
 * Deliberately free of line numbers. An id containing a line renumbers every
 * symbol below an inserted line, which makes a one-line edit look like a
 * whole-file rewrite and defeats identity entirely (design D7).
 */
export type SymbolId = string;

export interface SymbolRef {
  id: SymbolId;
  name: string;
  detail: string | null;
  /** LSP SymbolKind. */
  kind: number;
  /** Repo-relative POSIX path. */
  file: string;
  /** Full range of the declaration. */
  range: Range;
  /** Range of just the name. */
  selectionRange: Range;
  /** Dotted path including enclosing classes, e.g. `SMSSender.send`. */
  qualifiedName: string;
  /** Full definition text including the signature. Empty when external. */
  defText: string;
  /** Implementation body only, signature excluded. Empty when external. */
  blockText: string;
  /**
   * True when the symbol resolves outside the project root (stdlib stubs,
   * site-packages, typeshed). External symbols are recorded so the call is
   * visible, but are never expanded.
   */
  external: boolean;
}

/** A guarding construct enclosing a call site (design D3). */
export interface Condition {
  /** tree-sitter node type, e.g. `if_statement`, `else_clause`, `for_statement`. */
  kind: string;
  /** Source text of the controlling expression, where one exists. */
  text: string | null;
  /** True when this guard is the negative arm (`else`). */
  negated: boolean;
  /** Line of the guarding construct. */
  line: number;
}

/**
 * How a call site is reached within its caller.
 *
 * `argument` means the call is lexically an argument of another call, and is
 * therefore evaluated before it -- the relationship that makes
 * `notify(SMSSender(), "code")` a sequence rather than two independent calls.
 */
export type CallKind = "call" | "argument";

export interface CallSite {
  id: string;
  /** File containing the call expression (the caller's file). */
  file: string;
  range: Range;
  /**
   * Guards enclosing this call, outermost first. Empty for an unguarded call.
   * Conditions live on the call site, never on a node (design D4).
   */
  conditions: Condition[];
  /**
   * Position among the caller's call sites, in source order. Location metadata:
   * deliberately NOT part of any dependency hash, because inserting one call
   * would otherwise renumber every later call and mark them all stale.
   */
  ordinal: number;
  kind: CallKind;
  /** For an `argument`, the id of the call site it feeds. */
  enclosingSite: string | null;
}

/**
 * Provenance tiers for this change. An agent tier is deliberately absent;
 * nothing in this system infers edges.
 */
export type Provenance = "lsp-verified" | "heuristic" | "declared-unresolved";

/**
 * One edge per call site. Two calls from the same caller to the same callee
 * under different guards are different edges, because the guard is part of
 * what the edge means.
 */
export interface Edge {
  id: string;
  from: SymbolId;
  to: SymbolId;
  site: CallSite;
  provenance: Provenance;
  /** Populated when the call dispatches through a declared type. */
  candidates: SymbolRef[];
  /** Set when this edge closes a cycle; the target is not expanded. */
  closesCycle: boolean;
  /** For a heuristically resolved edge, the target the language server reported. */
  declaredTarget: SymbolId | null;
}

export type UnresolvedReason = "dispatch-candidates" | "ambiguous-construction";

/** A hole: a call whose concrete target is not known (design D5). */
export interface UnresolvedCall {
  id: string;
  siteId: string;
  /** The target the language server did resolve, e.g. the base method. */
  declaredTarget: SymbolId;
  reason: UnresolvedReason;
  candidates: SymbolRef[];
}

export interface FlowFacts {
  root: SymbolId;
  maxDepth: number;
  symbols: Record<SymbolId, SymbolRef>;
  edges: Edge[];
  unresolved: UnresolvedCall[];
  /** Nodes not expanded because the depth bound was reached. */
  truncated: SymbolId[];
  /** Nodes not expanded because they resolve outside the project root. */
  external: SymbolId[];
  /** Nodes that were reached again while already on the traversal path. */
  cycles: SymbolId[];
}

export function symbolId(file: string, qualifiedName: string): SymbolId {
  return `${file}#${qualifiedName}`;
}

/** External symbols are not parsed, so fall back to a line-qualified id. */
export function externalSymbolId(file: string, name: string, line: number): SymbolId {
  return `${file}#${name}@${line}`;
}

/**
 * Identity for the nth call from `from` to `to`, in source order.
 *
 * Ordinal rather than line-based for the same reason symbol ids are: an
 * absolute line makes every edge below an inserted line look new.
 */
export function edgeId(from: SymbolId, to: SymbolId, ordinal: number): string {
  return `${from}->${to}#${ordinal}`;
}
