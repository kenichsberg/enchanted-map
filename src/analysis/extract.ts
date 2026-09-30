import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageServer, Range } from "../lsp/server.ts";
import type { BranchIndex } from "./branches.ts";
import type { FactCache } from "../cache/store.ts";
import { hashParts } from "../cache/store.ts";
import { canonicalCached } from "../util/paths.ts";
import {
  type CallSite,
  type Edge,
  type FlowFacts,
  type SymbolId,
  type SymbolRef,
  type UnresolvedCall,
  edgeId,
  externalSymbolId,
  symbolId,
} from "./types.ts";

interface CallHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
}

interface OutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

export interface ExtractOptions {
  maxDepth: number;
}

export class Extractor {
  #server: LanguageServer;
  #root: string;
  #branches: BranchIndex | null;
  #cache: FactCache | null = null;

  /**
   * `branches` supplies the guards enclosing each call site. The language
   * server reports where a call happens; only tree-sitter can say under what
   * condition it is reached (design D3).
   */
  constructor(server: LanguageServer, branches?: BranchIndex) {
    this.#server = server;
    this.#root = canonicalCached(server.root);
    this.#branches = branches ?? null;
  }

  /** Attach a fact cache. Unchanged content is then served without LSP traffic. */
  withCache(cache: FactCache): this {
    this.#cache = cache;
    return this;
  }

  relative(uri: string): string {
    const file = canonicalCached(fileURLToPath(uri));
    return path.relative(this.#root, file).split(path.sep).join("/");
  }

  /** A path outside the project root escapes it with a leading `..`. */
  static isExternal(relPath: string): boolean {
    return relPath.startsWith("../") || path.isAbsolute(relPath);
  }

  /**
   * Machine-independent label for a file outside the project.
   *
   * The real path runs through node_modules and differs per checkout; flow
   * files are committed, so an absolute path there would produce spurious
   * diffs for every teammate.
   */
  static externalLabel(relPath: string): string {
    const marker = "node_modules/";
    const idx = relPath.lastIndexOf(marker);
    if (idx >= 0) return `<ext>/${relPath.slice(idx + marker.length)}`;
    return `<ext>/${relPath.split("/").pop() ?? relPath}`;
  }

  toSymbolRef(item: CallHierarchyItem): SymbolRef {
    const raw = this.relative(item.uri);
    const external = Extractor.isExternal(raw);
    const file = external ? Extractor.externalLabel(raw) : raw;

    // Identity and body come from tree-sitter: the language server's range is
    // too narrow to hash, and a line-based id churns on any insertion above.
    let qualifiedName = item.name;
    let defText = "";
    let blockText = "";
    if (!external && this.#branches) {
      const def = this.#branches.definitionAt(raw, item.selectionRange.start);
      if (def) {
        qualifiedName = def.qualifiedName;
        defText = def.text;
        blockText = def.blockText;
      }
    }

    return {
      id: external
        ? externalSymbolId(file, item.name, item.selectionRange.start.line)
        : symbolId(file, qualifiedName),
      name: item.name,
      qualifiedName,
      defText,
      blockText,
      detail: item.detail ?? null,
      kind: item.kind,
      file,
      range: item.range,
      selectionRange: item.selectionRange,
      external,
    };
  }

  /** Resolve the call hierarchy item at a position, or null if there is none. */
  async prepare(file: string, line: number, character: number): Promise<SymbolRef | null> {
    const uri = this.#server.openDocument(file);
    const items = (await this.#server.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri },
      position: { line, character },
    })) as CallHierarchyItem[] | null;
    const first = items?.[0];
    return first ? this.toSymbolRef(first) : null;
  }

  async outgoing(item: SymbolRef): Promise<OutgoingCall[]> {
    // Keyed on the containing file's content: if that file is byte-identical,
    // the call sites within it are too. A change in a CALLEE's file invalidates
    // that callee's own entry, which is where its facts are recorded.
    const key = this.#cache
      ? `outgoing.${this.#cache.fileHash(item.file)}.${hashKey(item.id)}`
      : null;
    if (key && this.#cache) {
      const hit = this.#cache.get<OutgoingCall[]>(key);
      if (hit !== undefined) return hit;
    }
    this.#server.openDocument(item.file);
    const calls = (await this.#server.request("callHierarchy/outgoingCalls", {
      item: {
        name: item.name,
        kind: item.kind,
        uri: this.#server.uriFor(item.file),
        range: item.range,
        selectionRange: item.selectionRange,
        ...(item.detail !== null ? { detail: item.detail } : {}),
      },
    })) as OutgoingCall[] | null;
    const result = calls ?? [];
    if (key && this.#cache) this.#cache.set(key, result);
    return result;
  }

  /**
   * Depth-bounded depth-first traversal from `root`.
   *
   * A node already on the current path closes a cycle: the edge is recorded and
   * marked, but the node is not expanded again. A node visited on some earlier
   * branch is simply not re-expanded -- that is DAG re-convergence, not a cycle.
   */
  async traverse(root: SymbolRef, opts: ExtractOptions): Promise<FlowFacts> {
    const symbols: Record<SymbolId, SymbolRef> = { [root.id]: root };
    const edges: Edge[] = [];
    const unresolved: UnresolvedCall[] = [];
    const truncated: SymbolId[] = [];
    const external = new Set<SymbolId>();
    const cycles = new Set<SymbolId>();
    const expanded = new Set<SymbolId>();
    const onPath = new Set<SymbolId>();

    const visit = async (node: SymbolRef, depth: number): Promise<void> => {
      if (node.external) {
        external.add(node.id);
        return;
      }
      if (depth >= opts.maxDepth) {
        if (!truncated.includes(node.id)) truncated.push(node.id);
        return;
      }
      if (expanded.has(node.id)) return;
      expanded.add(node.id);
      onPath.add(node.id);

      const calls = await this.outgoing(node);

      // Pass 1: flatten this caller's call sites and learn their structure.
      // The language server groups call sites by callee, so its order says
      // nothing about the order the code runs in.
      interface RawSite {
        target: SymbolRef;
        fromRange: Range;
        /** Byte offset of the call expression; the key arguments link on. */
        offset: number | null;
        enclosingOffset: number | null;
        /** Ordering key, usable even when tree-sitter could not locate the call. */
        sortKey: number;
      }
      const raws: RawSite[] = [];
      const uniqueTargets: SymbolRef[] = [];
      const seenTargets = new Set<SymbolId>();

      for (const call of calls) {
        const target = this.toSymbolRef(call.to);
        symbols[target.id] ??= target;
        if (!seenTargets.has(target.id)) {
          seenTargets.add(target.id);
          uniqueTargets.push(target);
        }
        for (const fromRange of call.fromRanges) {
          const info = this.#branches?.callSiteInfo(node.file, fromRange.start) ?? null;
          raws.push({
            target,
            fromRange,
            offset: info?.offset ?? null,
            enclosingOffset: info?.enclosingOffset ?? null,
            sortKey:
              info?.offset ??
              fromRange.start.line * 1_000_000 + fromRange.start.character,
          });
        }
      }

      // Pass 2: source order, then identity. Within a (caller, callee) pair the
      // relative order is unchanged, so edge ids stay exactly as before.
      raws.sort((a, b) => a.sortKey - b.sortKey);
      const pairOrdinals = new Map<string, number>();
      const siteIdByOffset = new Map<number, string>();
      const assigned = raws.map((raw, index) => {
        const pairKey = `${node.id}->${raw.target.id}`;
        const pairOrdinal = pairOrdinals.get(pairKey) ?? 0;
        pairOrdinals.set(pairKey, pairOrdinal + 1);
        const id = edgeId(node.id, raw.target.id, pairOrdinal);
        if (raw.offset !== null) siteIdByOffset.set(raw.offset, id);
        return { raw, id, ordinal: index };
      });

      for (const { raw, id, ordinal } of assigned) {
        const enclosingSite =
          raw.enclosingOffset !== null
            ? (siteIdByOffset.get(raw.enclosingOffset) ?? null)
            : null;
        const closes = onPath.has(raw.target.id);
        if (closes) cycles.add(raw.target.id);

        const site: CallSite = {
          id,
          file: node.file,
          range: raw.fromRange,
          conditions: this.#branches?.conditionsAt(node.file, raw.fromRange) ?? [],
          ordinal,
          kind: enclosingSite !== null ? "argument" : "call",
          enclosingSite,
        };
        edges.push({
          id,
          from: node.id,
          to: raw.target.id,
          site,
          provenance: "lsp-verified",
          candidates: [],
          closesCycle: closes,
          declaredTarget: null,
        });
      }

      for (const target of uniqueTargets) {
        if (!onPath.has(target.id)) await visit(target, depth + 1);
      }

      onPath.delete(node.id);
    };

    await visit(root, 0);

    return {
      root: root.id,
      maxDepth: opts.maxDepth,
      symbols,
      edges,
      unresolved,
      truncated,
      external: [...external],
      cycles: [...cycles],
    };
  }
}

function hashKey(id: string): string {
  return hashParts(id);
}
