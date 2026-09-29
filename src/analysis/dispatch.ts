import type { LanguageServer, Location, Range } from "../lsp/server.ts";
import type { Extractor } from "./extract.ts";
import type { Edge, FlowFacts, SymbolRef, UnresolvedCall } from "./types.ts";

/** LSP SymbolKind values we care about. */
export const KIND = { Class: 5, Method: 6, Function: 12, Constructor: 9 } as const;

interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

function contains(outer: Range, inner: Range): boolean {
  if (outer.start.line > inner.start.line) return false;
  if (outer.end.line < inner.end.line) return false;
  return true;
}

export class DispatchResolver {
  #server: LanguageServer;
  #extractor: Extractor;
  #symbolCache = new Map<string, DocumentSymbol[]>();

  constructor(server: LanguageServer, extractor: Extractor) {
    this.#server = server;
    this.#extractor = extractor;
  }

  async #documentSymbols(file: string): Promise<DocumentSymbol[]> {
    const cached = this.#symbolCache.get(file);
    if (cached) return cached;
    const uri = this.#server.openDocument(file);
    const syms =
      ((await this.#server.request("textDocument/documentSymbol", {
        textDocument: { uri },
      })) as DocumentSymbol[] | null) ?? [];
    this.#symbolCache.set(file, syms);
    return syms;
  }

  /** Name of the class enclosing `range`, or null when the symbol is free-standing. */
  async owningClass(file: string, range: Range): Promise<string | null> {
    const syms = await this.#documentSymbols(file);
    const walk = (nodes: DocumentSymbol[], inherited: string | null): string | null => {
      for (const s of nodes) {
        if (!contains(s.range, range)) continue;
        const owner = s.kind === KIND.Class ? s.name : inherited;
        return walk(s.children ?? [], owner) ?? owner;
      }
      return null;
    };
    return walk(syms, null);
  }

  /** Candidate implementations for the symbol, excluding the declared symbol itself. */
  async candidatesFor(target: SymbolRef): Promise<SymbolRef[]> {
    if (target.external) return [];
    if (target.kind !== KIND.Method && target.kind !== KIND.Function) return [];

    const uri = this.#server.uriFor(target.file);
    const raw = (await this.#server.request("textDocument/implementation", {
      textDocument: { uri },
      position: target.selectionRange.start,
    })) as Location | Location[] | null;
    if (!raw) return [];
    const locations = Array.isArray(raw) ? raw : [raw];

    const out: SymbolRef[] = [];
    for (const loc of locations) {
      const file = this.#extractor.relative(loc.uri);
      const ref = await this.#extractor.prepare(
        file,
        loc.range.start.line,
        loc.range.start.character,
      );
      if (!ref) continue;
      if (ref.id === target.id) continue; // the declared symbol itself
      if (out.some((o) => o.id === ref.id)) continue;
      out.push(ref);
    }
    return out;
  }

  /**
   * Annotate facts in place with dispatch candidates, holes, and any resolution
   * the constructor-evidence heuristic can justify.
   */
  async annotate(facts: FlowFacts): Promise<FlowFacts> {
    const candidateCache = new Map<string, SymbolRef[]>();
    const holes: UnresolvedCall[] = [];

    for (const edge of facts.edges) {
      const target = facts.symbols[edge.to];
      if (!target || target.external) continue;

      let candidates = candidateCache.get(target.id);
      if (candidates === undefined) {
        candidates = await this.candidatesFor(target);
        candidateCache.set(target.id, candidates);
      }
      // No implementations means an ordinary call to a single concrete target.
      // Recording that as a hole would bury the real holes in noise.
      if (candidates.length === 0) continue;

      for (const c of candidates) facts.symbols[c.id] ??= c;
      edge.candidates = candidates;

      const resolved = await this.#resolveByConstruction(facts, edge, candidates);
      if (resolved) {
        edge.provenance = "heuristic";
        edge.declaredTarget = edge.to;
        edge.to = resolved.id;
      } else {
        edge.provenance = "declared-unresolved";
        holes.push({
          id: `hole:${edge.id}`,
          siteId: edge.site.id,
          declaredTarget: target.id,
          reason: "dispatch-candidates",
          candidates,
        });
      }
    }

    facts.unresolved = holes;
    return facts;
  }

  /**
   * Constructor evidence, single hop (design D6).
   *
   * The dispatching call lives in some function F. We look at the call sites
   * where F itself is invoked, and ask which candidate classes are constructed
   * at that same call site. One distinct class resolves it; anything else
   * leaves the hole open, because guessing here is worse than admitting we
   * do not know.
   */
  async #resolveByConstruction(
    facts: FlowFacts,
    dispatchEdge: Edge,
    candidates: SymbolRef[],
  ): Promise<SymbolRef | null> {
    const owners = new Map<string, SymbolRef>();
    for (const c of candidates) {
      const cls = await this.owningClass(c.file, c.selectionRange);
      if (cls) owners.set(cls, c);
    }
    if (owners.size === 0) return null;

    // Call sites where the dispatching function is itself invoked.
    const inbound = facts.edges.filter((e) => e.to === dispatchEdge.from);
    if (inbound.length === 0) return null;

    const constructed = new Set<string>();
    for (const call of inbound) {
      for (const sibling of facts.edges) {
        if (sibling.from !== call.from) continue;
        if (sibling.site.file !== call.site.file) continue;
        if (sibling.site.range.start.line !== call.site.range.start.line) continue;
        const ctor = facts.symbols[sibling.to];
        if (ctor && ctor.kind === KIND.Class && owners.has(ctor.name)) {
          constructed.add(ctor.name);
        }
      }
    }
    if (constructed.size !== 1) return null; // none, or ambiguous
    const only = [...constructed][0];
    return only ? (owners.get(only) ?? null) : null;
  }
}
