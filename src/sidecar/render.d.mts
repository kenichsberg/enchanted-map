import type { FlowView, DiffView, StalenessView, ProvenanceView } from "../views/index.ts";

export function esc(s: unknown): string;
export function trunc(s: string, n: number): string;

export interface LayoutNode {
  id: string;
  label: string;
  qualifiedName: string;
  file: string;
  line: number;
  external: boolean;
  stale: boolean;
  staleReasons: string[];
  truncated: boolean;
  cycle: boolean;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  isArgument?: boolean;
}

export interface LayoutResult {
  nodes: Map<string, LayoutNode>;
  width: number;
  height: number;
  feeds: Map<string, string>;
  dockedInto: Map<string, Array<{ node: LayoutNode; edge: unknown }>>;
  dockedIds: Set<string>;
  DOCK_H: number;
  H: number;
}

export function layout(view: FlowView): LayoutResult;
export function renderFlow(view: FlowView): string;
export function renderDiff(view: DiffView): string;
export function renderStale(view: StalenessView): string;
export function renderProvenance(view: ProvenanceView): string;
