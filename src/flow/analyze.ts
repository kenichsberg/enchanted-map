import { LanguageServer } from "../lsp/server.ts";
import { Extractor } from "../analysis/extract.ts";
import { BranchIndex } from "../analysis/branches.ts";
import { DispatchResolver } from "../analysis/dispatch.ts";
import { FactCache } from "../cache/store.ts";
import type { EntryPointDecl } from "./config.ts";
import { flowFromFacts, type Flow } from "./model.ts";
import { readFlow } from "./store.ts";
import { canonical } from "../util/paths.ts";

export interface AnalyzeOptions {
  maxDepth?: number;
  cache?: FactCache;
  serverCommand?: string[];
  /** Directory names marking third-party code; defaults when omitted. */
  markers?: readonly string[];
}

export class BrokenEntryPointError extends Error {
  readonly decl: EntryPointDecl;
  constructor(decl: EntryPointDecl, detail: string) {
    super(`entry point '${decl.name}' no longer resolves: ${detail}`);
    this.name = "BrokenEntryPointError";
    this.decl = decl;
  }
}

/**
 * Analyze one flow end to end. Holds a language server for the duration and
 * shuts it down afterwards, so nothing is left running.
 */
export class FlowAnalyzer {
  readonly root: string;
  #opts: AnalyzeOptions;

  constructor(root: string, opts: AnalyzeOptions = {}) {
    this.root = canonical(root);
    this.#opts = opts;
  }

  async analyze(decl: EntryPointDecl): Promise<Flow> {
    const server = new LanguageServer(this.root, this.#opts.serverCommand);
    await server.start();
    try {
      const branches = await BranchIndex.create(this.root);
      const extractor = new Extractor(server, branches, this.#opts.markers);
      const cache = this.#opts.cache ?? new FactCache(this.root);
      extractor.withCache(cache);

      const pos = await locateSymbol(server, decl.file, decl.symbol);
      if (!pos) {
        throw new BrokenEntryPointError(decl, `no symbol '${decl.symbol}' in ${decl.file}`);
      }
      const rootRef = await extractor.prepare(decl.file, pos.line, pos.character);
      if (!rootRef) {
        throw new BrokenEntryPointError(
          decl,
          `no call hierarchy item at ${decl.file}:${pos.line + 1}`,
        );
      }

      const facts = await extractor.traverse(rootRef, {
        maxDepth: this.#opts.maxDepth ?? 3,
      });
      await new DispatchResolver(server, extractor).annotate(facts);
      branches.dispose();

      const previous = readFlow(this.root, decl.name);
      return flowFromFacts(this.root, decl.name, { file: decl.file, symbol: decl.symbol }, facts, previous);
    } finally {
      await server.stop();
    }
  }
}

interface DocSym {
  name: string;
  selectionRange?: { start: { line: number; character: number } };
  location?: { range: { start: { line: number; character: number } } };
  children?: DocSym[];
}

export async function locateSymbol(
  server: LanguageServer,
  file: string,
  name: string,
): Promise<{ line: number; character: number } | null> {
  let uri: string;
  try {
    uri = server.openDocument(file);
  } catch {
    return null; // file is gone
  }
  const syms = (await server.request("textDocument/documentSymbol", {
    textDocument: { uri },
  })) as DocSym[] | null;

  const walk = (nodes: DocSym[] | null | undefined): { line: number; character: number } | null => {
    for (const s of nodes ?? []) {
      if (s.name === name) {
        const p = s.selectionRange?.start ?? s.location?.range.start;
        if (p) return p;
      }
      const inner = walk(s.children);
      if (inner) return inner;
    }
    return null;
  };
  return walk(syms);
}
