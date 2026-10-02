import { FlowAnalyzer, BrokenEntryPointError } from "./analyze.ts";
import { loadConfig, type EntryPointDecl, type ProjectConfig } from "./config.ts";
import { readFlow, writeFlow, listFlows, markBroken } from "./store.ts";
import { computeStaleness, currentRevision, accept, type StalenessReport } from "./staleness.ts";
import type { Flow } from "./model.ts";
import {
  curate,
  holeOffers,
  recordDecline,
  recordResolution,
  withdrawJudgment,
  CurationError,
  type DispatchJudgment,
  type HoleOffer,
  type RecordOptions,
} from "./judgments.ts";
import { FactCache } from "../cache/store.ts";
import { resolveMarkers } from "../analysis/vendor.ts";
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
    const config = this.config();
    return new FlowAnalyzer(this.root, {
      maxDepth: config.maxDepth,
      cache: this.#cache,
      markers: resolveMarkers(config.vendor),
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

  // ------------------------------------------------------------ curation --
  //
  // Every method below writes a judgment, and each is reachable only from an
  // explicit request. Nothing on the analysis or staleness paths calls them:
  // that is what "curation never runs unasked" means in code.

  /**
   * The stored flow a judgment applies to.
   *
   * Deliberately the stored one rather than a fresh analysis: a judgment is
   * recorded against the facts the agent was shown, and re-analysing here
   * would let the hole move between reading it and answering it.
   */
  #curatable(name: string): Flow {
    const flow = readFlow(this.root, name);
    if (!flow) {
      throw new CurationError(
        `flow '${name}' has not been analyzed yet (root: ${this.root}). ` +
          `Analyze it first; curation never analyzes on your behalf.`,
      );
    }
    return flow;
  }

  /** Every hole in a flow, open and settled alike. */
  holes(name: string): HoleOffer[] {
    return holeOffers(this.#curatable(name));
  }

  /** Record a dispatch resolution by the candidate's position (design D2). */
  resolveDispatch(
    name: string,
    holeId: string,
    candidateIndex: number,
    opts: RecordOptions = {},
  ): { flow: Flow; judgment: DispatchJudgment; holeId: string } {
    const { flow, judgment, hole } = recordResolution(
      this.#curatable(name),
      holeId,
      candidateIndex,
      opts,
    );
    writeFlow(this.root, flow);
    return { flow, judgment, holeId: hole.id };
  }

  /** Record that a hole was considered and could not be answered (design D3). */
  declineDispatch(
    name: string,
    holeId: string,
    reason: string,
    opts: RecordOptions = {},
  ): { flow: Flow; judgment: DispatchJudgment; holeId: string } {
    const { flow, judgment, hole } = recordDecline(
      this.#curatable(name),
      holeId,
      reason,
      opts,
    );
    writeFlow(this.root, flow);
    return { flow, judgment, holeId: hole.id };
  }

  /** Remove a judgment, returning the hole to its unresolved state. */
  withdrawJudgment(name: string, holeId: string): { flow: Flow; siteId: string } {
    const { flow, siteId } = withdrawJudgment(this.#curatable(name), holeId);
    writeFlow(this.root, flow);
    return { flow, siteId };
  }

  /** The stored flow with its current judgments applied. */
  curated(name: string): Flow | null {
    const flow = readFlow(this.root, name);
    return flow ? curate(flow).flow : null;
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
