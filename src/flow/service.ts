import { FlowAnalyzer, BrokenEntryPointError } from "./analyze.ts";
import { loadConfig, type EntryPointDecl, type ProjectConfig } from "./config.ts";
import { readFlow, writeFlow, listFlows, markBroken } from "./store.ts";
import { computeStaleness, currentRevision, accept, type StalenessReport } from "./staleness.ts";
import type { Flow } from "./model.ts";
import { FactCache } from "../cache/store.ts";
import { canonical } from "../util/paths.ts";

export interface FlowStatus {
  name: string;
  stored: Flow | null;
  current: Flow | null;
  report: StalenessReport | null;
  broken: boolean;
  error: string | null;
}

/**
 * Orchestration shared by every surface: the editor, the canvas, and CI all
 * go through this, so none of them can drift from the others.
 */
export class FlowService {
  readonly root: string;
  #cache: FactCache;

  constructor(root: string) {
    this.root = canonical(root);
    this.#cache = new FactCache(root);
  }

  config(): ProjectConfig {
    return loadConfig(this.root);
  }

  entryPoint(name: string): EntryPointDecl | null {
    return this.config().entryPoints.find((e) => e.name === name) ?? null;
  }

  names(): string[] {
    const declared = this.config().entryPoints.map((e) => e.name);
    return [...new Set([...declared, ...listFlows(this.root)])].sort();
  }

  /** Analyze a flow from source. Does not write. */
  async analyze(name: string): Promise<Flow> {
    const decl = this.entryPoint(name);
    if (!decl) {
      // Root resolution is invisible to the user, so always say where we looked.
      const declared = this.config().entryPoints.map((e) => e.name);
      throw new Error(
        declared.length === 0
          ? `no entry points are declared in ${this.root}\n` +
            `  Declare one with: enchanted-map declare <name> <file> <symbol> --root ${this.root}`
          : `no entry point named '${name}' in ${this.root}\n` +
            `  Declared entry points: ${declared.join(", ")}`,
      );
    }
    this.#cache.invalidateFileHashes();
    return new FlowAnalyzer(this.root, {
      maxDepth: this.config().maxDepth,
      cache: this.#cache,
    }).analyze(decl);
  }

  /** Analyze and persist. */
  async refresh(name: string): Promise<Flow> {
    const flow = await this.analyze(name);
    writeFlow(this.root, flow);
    return flow;
  }

  stored(name: string): Flow | null {
    return readFlow(this.root, name);
  }

  /** Compare the stored flow against source, without writing anything. */
  async status(name: string): Promise<FlowStatus> {
    const stored = readFlow(this.root, name);
    try {
      const current = await this.analyze(name);
      const report = stored ? computeStaleness(this.root, stored, current) : null;
      return { name, stored, current, report, broken: false, error: null };
    } catch (e) {
      if (e instanceof BrokenEntryPointError) {
        if (stored) markBroken(this.root, name);
        return { name, stored, current: null, report: null, broken: true, error: e.message };
      }
      return {
        name,
        stored,
        current: null,
        report: null,
        broken: false,
        error: (e as Error).message,
      };
    }
  }

  async statusAll(): Promise<FlowStatus[]> {
    const out: FlowStatus[] = [];
    for (const name of this.names()) out.push(await this.status(name));
    return out;
  }

  /** Stamp the stored flow as accepted at the current revision. */
  accept(name: string): Flow {
    const flow = readFlow(this.root, name);
    if (!flow) throw new Error(`flow '${name}' has not been analyzed yet`);
    const rev = currentRevision(this.root) ?? "unversioned";
    const accepted = accept(flow, rev);
    writeFlow(this.root, accepted);
    return accepted;
  }
}
