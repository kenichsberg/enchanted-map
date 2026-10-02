import { execFileSync } from "node:child_process";
import type { SymbolId } from "../analysis/types.ts";
import type { AcceptStamp, Flow } from "./model.ts";
import { reconcile, type IdentityResult } from "./identity.ts";
import { judgmentState } from "./judgments.ts";

export type EntryKind = "node" | "edge" | "hole" | "judgment";

/**
 * One stale stored entry, attributed to the specific node or edge it affects.
 * Staleness is never reduced to a single flow-level flag (design D9).
 */
export interface StaleEntry {
  kind: EntryKind;
  /** Id of the stored entry. */
  id: string;
  /** The node or edge a surface should mark. */
  affects: string;
  reason: "changed" | "removed" | "added";
}

export interface StalenessReport {
  flow: string;
  entries: StaleEntry[];
  /** Nodes whose identity could not be carried across, so their entries reset. */
  invalidated: SymbolId[];
  get stale(): boolean;
}

export function currentRevision(root: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Compare a stored flow against freshly analyzed facts, per entry.
 *
 * A whole-file or whole-flow hash would make an unrelated log line invalidate
 * everything; that churn is what makes a map get ignored.
 */
export function computeStaleness(
  root: string,
  stored: Flow,
  current: Flow,
  opts: { fromRev?: string; identity?: IdentityResult } = {},
): StalenessReport {
  const identity =
    opts.identity ??
    reconcile(root, stored, current, opts.fromRev !== undefined ? { fromRev: opts.fromRev } : {});
  const entries: StaleEntry[] = [];

  const mapId = (id: SymbolId): SymbolId => identity.carried.get(id) ?? id;

  // Nodes.
  const currentNodes = new Map(current.nodes.map((n) => [n.id, n]));
  const storedNodeIds = new Set<string>();
  for (const prev of stored.nodes) {
    const nowId = mapId(prev.id);
    storedNodeIds.add(nowId);
    const now = currentNodes.get(nowId);
    if (!now) {
      entries.push({ kind: "node", id: prev.id, affects: prev.id, reason: "removed" });
      continue;
    }
    if (now.depHash !== prev.depHash) {
      entries.push({ kind: "node", id: nowId, affects: nowId, reason: "changed" });
    }
  }
  for (const now of current.nodes) {
    if (!storedNodeIds.has(now.id)) {
      entries.push({ kind: "node", id: now.id, affects: now.id, reason: "added" });
    }
  }

  // Edges.
  const currentEdges = new Map(current.edges.map((e) => [e.id, e]));
  const storedEdgeIds = new Set<string>();
  for (const prev of stored.edges) {
    const now = currentEdges.get(prev.id);
    storedEdgeIds.add(prev.id);
    if (!now) {
      entries.push({ kind: "edge", id: prev.id, affects: prev.id, reason: "removed" });
      continue;
    }
    if (now.depHash !== prev.depHash) {
      entries.push({ kind: "edge", id: prev.id, affects: prev.id, reason: "changed" });
    }
  }
  for (const now of current.edges) {
    if (!storedEdgeIds.has(now.id)) {
      entries.push({ kind: "edge", id: now.id, affects: now.id, reason: "added" });
    }
  }

  // Holes, and the judgments resting on them.
  //
  // A judgment is reported in its own right rather than left implicit in the
  // hole entry beside it. "This hole changed" and "the answer somebody gave for
  // this hole no longer holds" are different pieces of work: the first is
  // re-derived for free, the second has to be asked again.
  const currentHoles = new Map(current.holes.map((h) => [h.id, h]));
  const storedHoleIds = new Set<string>();
  for (const prev of stored.holes) {
    const now = currentHoles.get(prev.id);
    storedHoleIds.add(prev.id);
    const judgment = stored.judgments?.dispatch?.[prev.siteId];
    if (!now) {
      entries.push({ kind: "hole", id: prev.id, affects: prev.siteId, reason: "removed" });
      if (judgment) {
        entries.push({
          kind: "judgment",
          id: prev.siteId,
          affects: prev.siteId,
          reason: "removed",
        });
      }
      continue;
    }
    if (now.depHash !== prev.depHash) {
      entries.push({ kind: "hole", id: prev.id, affects: prev.siteId, reason: "changed" });
    }
    if (judgment && judgmentState(judgment, now) !== "current") {
      entries.push({ kind: "judgment", id: prev.siteId, affects: prev.siteId, reason: "changed" });
    }
  }
  for (const now of current.holes) {
    if (!storedHoleIds.has(now.id)) {
      entries.push({ kind: "hole", id: now.id, affects: now.siteId, reason: "added" });
    }
  }

  return {
    flow: stored.name,
    entries,
    invalidated: identity.invalidated,
    get stale() {
      return entries.length > 0;
    },
  };
}

export type AcceptanceState = "unaccepted" | "accepted" | "accepted-but-drifted";

/** Acceptance applies to the whole flow; there is no per-entry pinning (design D10). */
export function accept(flow: Flow, revision: string, at = new Date()): Flow {
  const stamp: AcceptStamp = { revision, at: at.toISOString() };
  return { ...flow, accepted: stamp };
}

export function acceptanceState(flow: Flow, report: StalenessReport | null): AcceptanceState {
  if (!flow.accepted) return "unaccepted";
  if (report?.stale) return "accepted-but-drifted";
  return "accepted";
}
