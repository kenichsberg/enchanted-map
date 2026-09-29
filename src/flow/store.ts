import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { flowsDir } from "./config.ts";
import { emptyJudgments, type Flow } from "./model.ts";

/** One file per flow, so merge conflicts are scoped to the same flow (design D8). */
export function flowPath(root: string, name: string): string {
  return path.join(flowsDir(root), `${name}.yaml`);
}

/** Deterministic key order; a flow written twice must be byte-identical. */
const KEY_ORDER = [
  "name",
  "entryPoint",
  "maxDepth",
  "root",
  "broken",
  "accepted",
  "judgments",
  "truncated",
  "external",
  "cycles",
  "nodes",
  "edges",
  "holes",
] as const;

function ordered(flow: Flow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) out[k] = flow[k as keyof Flow];
  return out;
}

export function writeFlow(root: string, flow: Flow): string {
  const file = flowPath(root, flow.name);
  mkdirSync(path.dirname(file), { recursive: true });
  const text = YAML.stringify(ordered(flow), { lineWidth: 0, sortMapEntries: false });
  writeFileSync(file, text, "utf8");
  return file;
}

export function readFlow(root: string, name: string): Flow | null {
  const file = flowPath(root, name);
  if (!existsSync(file)) return null;
  const raw = YAML.parse(readFileSync(file, "utf8")) as Partial<Flow> | null;
  if (!raw?.name) return null;
  // Judgment slots must parse even when a human (or a later agent) filled them.
  const judgments = {
    labels: raw.judgments?.labels ?? {},
    clusters: raw.judgments?.clusters ?? [],
    dispatch: raw.judgments?.dispatch ?? {},
  };
  return {
    name: raw.name,
    entryPoint: raw.entryPoint ?? { file: "", symbol: "" },
    maxDepth: raw.maxDepth ?? 3,
    root: raw.root ?? "",
    nodes: raw.nodes ?? [],
    edges: raw.edges ?? [],
    holes: raw.holes ?? [],
    truncated: raw.truncated ?? [],
    external: raw.external ?? [],
    cycles: raw.cycles ?? [],
    judgments: { ...emptyJudgments(), ...judgments },
    accepted: raw.accepted ?? null,
    broken: raw.broken ?? false,
  };
}

export function listFlows(root: string): string[] {
  const dir = flowsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -5))
    .sort();
}

/** Mark a flow whose entry point no longer resolves. The file is kept, not deleted. */
export function markBroken(root: string, name: string): Flow | null {
  const flow = readFlow(root, name);
  if (!flow) return null;
  flow.broken = true;
  writeFlow(root, flow);
  return flow;
}
