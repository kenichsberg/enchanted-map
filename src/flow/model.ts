import { readFileSync } from "node:fs";
import path from "node:path";
import { hashContent, hashParts } from "../cache/store.ts";
import type {
  CallKind,
  Condition,
  FlowFacts,
  SymbolId,
  SymbolRef,
} from "../analysis/types.ts";

/** A node as persisted in a flow file. */
export interface FlowNode {
  id: SymbolId;
  name: string;
  /** Dotted path including enclosing classes. */
  qualifiedName: string;
  file: string;
  /** 0-based line of the declaration name. Location only -- not part of identity. */
  line: number;
  kind: number;
  external: boolean;
  /**
   * Hash of the implementation body, signature excluded. Drives identity (D7),
   * so that a pure rename is recognised as the same node.
   */
  bodyHash: string;
  /** Hash of the inputs this entry depends on, signature included (D9). */
  depHash: string;
}

export interface FlowEdge {
  id: string;
  from: SymbolId;
  to: SymbolId;
  file: string;
  line: number;
  character: number;
  conditions: Condition[];
  /** Position among the caller's call sites, in source order. */
  ordinal: number;
  kind: CallKind;
  /** For an `argument`, the id of the edge whose call site it feeds. */
  enclosingSite: string | null;
  provenance: string;
  declaredTarget: SymbolId | null;
  candidates: SymbolId[];
  closesCycle: boolean;
  depHash: string;
}

export interface FlowHole {
  id: string;
  siteId: string;
  declaredTarget: SymbolId;
  reason: string;
  candidates: SymbolId[];
  depHash: string;
}

/**
 * Reserved slots for probabilistic judgments. Nothing in this system populates
 * them by inference; a human may, and a later agent layer will.
 */
export interface FlowJudgments {
  /** symbolId -> human-readable label. */
  labels: Record<string, string>;
  /** Named groups of nodes that are "one thing". */
  clusters: Array<{ name: string; members: SymbolId[] }>;
  /** callSiteId -> chosen concrete target. */
  dispatch: Record<string, string>;
}

export interface AcceptStamp {
  revision: string;
  at: string;
}

export interface Flow {
  name: string;
  entryPoint: { file: string; symbol: string };
  maxDepth: number;
  root: SymbolId;
  nodes: FlowNode[];
  edges: FlowEdge[];
  holes: FlowHole[];
  truncated: SymbolId[];
  external: SymbolId[];
  cycles: SymbolId[];
  judgments: FlowJudgments;
  accepted: AcceptStamp | null;
  /** True when the entry point no longer resolves; the file is kept regardless. */
  broken: boolean;
  /**
   * True when the stored file predates fields this version records, so it
   * cannot express the current model. Such a flow must not be presented as if
   * it were current: a silently defaulted map looks right and is not.
   */
  legacy: boolean;
}

export function emptyJudgments(): FlowJudgments {
  return { labels: {}, clusters: [], dispatch: {} };
}

/**
 * Full definition text, signature included. Drives staleness: a changed
 * signature is a real change and should mark the node stale.
 *
 * Prefers the tree-sitter text captured during extraction; the language
 * server's own range is too narrow to detect a body edit.
 */
export function symbolDefText(root: string, sym: SymbolRef): string {
  if (sym.external) return "";
  if (sym.defText) return sym.defText;
  try {
    const lines = readFileSync(path.resolve(root, sym.file), "utf8").split("\n");
    return lines.slice(sym.range.start.line, sym.range.end.line + 1).join("\n");
  } catch {
    return "";
  }
}

/**
 * Implementation body only, signature excluded. Drives identity.
 *
 * Identity and staleness need different inputs: renaming a function must still
 * mark it stale, but it must NOT make it a different node. Hashing the whole
 * definition for both conflates them, and every rename then reads as a delete
 * plus an add (design D7).
 */
export function symbolBlockText(root: string, sym: SymbolRef): string {
  if (sym.external) return "";
  return sym.blockText;
}

function lineText(root: string, file: string, line: number): string {
  try {
    return (readFileSync(path.resolve(root, file), "utf8").split("\n")[line] ?? "").trim();
  } catch {
    return "";
  }
}

function serialiseConditions(conds: Condition[]): string {
  return conds.map((c) => `${c.kind}:${c.negated ? "!" : ""}${c.text ?? ""}`).join("|");
}

/**
 * Dependency-scoped hashes (design D9).
 *
 * Each entry hashes only the inputs it actually used, so an unrelated edit
 * elsewhere in the file does not churn it. Getting these scopes right is also
 * what will make a later agent layer's memoisation stable.
 */
export const depHashes = {
  /** A node depends on its own full definition text, signature included. */
  node(defHash: string): string {
    return hashParts("node", defHash);
  },
  /**
   * An edge depends on its call-site line, the guards reaching it, and how it
   * is reached -- statement level, or as an argument of a particular call.
   *
   * The source ordinal is deliberately absent. Including it would mean that
   * inserting one call at the top of a function renumbers every later call and
   * marks all of their edges stale: the same "a small change looks like a big
   * one" failure that line-numbered identifiers caused (design D4).
   */
  edge(
    callLineText: string,
    conditions: Condition[],
    kind: CallKind,
    enclosingSite: string | null,
  ): string {
    return hashParts(
      "edge",
      callLineText,
      serialiseConditions(conditions),
      kind,
      enclosingSite ?? "",
    );
  },
  /** A hole depends on the declared target and the candidate set -- not on any body. */
  hole(declaredTarget: SymbolId, candidates: SymbolId[]): string {
    return hashParts("hole", declaredTarget, [...candidates].sort().join(","));
  },
};

/** Build a persistable Flow from freshly extracted facts. */
export function flowFromFacts(
  root: string,
  name: string,
  entryPoint: { file: string; symbol: string },
  facts: FlowFacts,
  previous?: Flow | null,
): Flow {
  const nodes: FlowNode[] = Object.values(facts.symbols)
    .map((s) => {
      const bodyHash = hashContent(symbolBlockText(root, s));
      return {
        id: s.id,
        name: s.name,
        qualifiedName: s.qualifiedName,
        file: s.file,
        line: s.selectionRange.start.line,
        kind: s.kind,
        external: s.external,
        bodyHash,
        depHash: depHashes.node(hashContent(symbolDefText(root, s))),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const edges: FlowEdge[] = facts.edges
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      file: e.site.file,
      line: e.site.range.start.line,
      character: e.site.range.start.character,
      conditions: e.site.conditions,
      ordinal: e.site.ordinal,
      kind: e.site.kind,
      enclosingSite: e.site.enclosingSite,
      provenance: e.provenance,
      declaredTarget: e.declaredTarget,
      candidates: e.candidates.map((c) => c.id).sort(),
      closesCycle: e.closesCycle,
      depHash: depHashes.edge(
        lineText(root, e.site.file, e.site.range.start.line),
        e.site.conditions,
        e.site.kind,
        e.site.enclosingSite,
      ),
    }))
    .sort((a, b) =>
      a.from === b.from ? a.ordinal - b.ordinal : a.from.localeCompare(b.from),
    );

  const holes: FlowHole[] = facts.unresolved
    .map((h) => {
      const candidates = h.candidates.map((c) => c.id).sort();
      return {
        id: h.id,
        siteId: h.siteId,
        declaredTarget: h.declaredTarget,
        reason: h.reason,
        candidates,
        depHash: depHashes.hole(h.declaredTarget, candidates),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    name,
    entryPoint,
    maxDepth: facts.maxDepth,
    root: facts.root,
    nodes,
    edges,
    holes,
    truncated: [...facts.truncated].sort(),
    external: [...facts.external].sort(),
    cycles: [...facts.cycles].sort(),
    // Curation survives re-analysis; it is the thing the human owns.
    judgments: previous?.judgments ?? emptyJudgments(),
    accepted: previous?.accepted ?? null,
    broken: false,
    legacy: false,
  };
}
