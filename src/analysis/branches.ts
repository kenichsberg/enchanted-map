import { readFileSync } from "node:fs";
import path from "node:path";
import { Parser, Language, type Node, type Tree } from "web-tree-sitter";
import type { Condition, Range } from "./types.ts";
import { canonical } from "../util/paths.ts";

const GRAMMAR = path.resolve(
  import.meta.dirname,
  "../../node_modules/tree-sitter-python/tree-sitter-python.wasm",
);

let parserPromise: Promise<Parser> | null = null;

async function getParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init();
    const lang = await Language.load(readFileSync(GRAMMAR));
    const p = new Parser();
    p.setLanguage(lang);
    return p;
  })();
  return parserPromise;
}

function text(node: Node | null): string | null {
  const t = node?.text.trim();
  return t ? t.replace(/\s+/g, " ") : null;
}

/**
 * Guarding constructs, and how to describe them. A call's guards are collected
 * by walking UP from the call site; the language server never reports these.
 */
function guardFor(node: Node, cameFrom: Node | null): Condition | null {
  const line = node.startPosition.row;
  switch (node.type) {
    case "if_statement": {
      // Only a call in the consequence is guarded positively by this `if`.
      // Arrival via an elif/else clause is described by that clause instead.
      const consequence = node.childForFieldName("consequence");
      if (cameFrom && consequence && cameFrom.id === consequence.id) {
        return {
          kind: "if_statement",
          text: text(node.childForFieldName("condition")),
          negated: false,
          line,
        };
      }
      return null;
    }
    case "elif_clause":
      return {
        kind: "elif_clause",
        text: text(node.childForFieldName("condition")),
        negated: false,
        line,
      };
    case "else_clause": {
      // The negative arm of whatever it belongs to.
      const owner = node.parent;
      const cond =
        owner?.type === "if_statement" || owner?.type === "while_statement"
          ? text(owner.childForFieldName("condition"))
          : null;
      return { kind: "else_clause", text: cond, negated: true, line };
    }
    case "for_statement": {
      const body = node.childForFieldName("body");
      if (cameFrom && body && cameFrom.id !== body.id) return null;
      const left = text(node.childForFieldName("left"));
      const right = text(node.childForFieldName("right"));
      return {
        kind: "for_statement",
        text: left && right ? `for ${left} in ${right}` : null,
        negated: false,
        line,
      };
    }
    case "while_statement": {
      const body = node.childForFieldName("body");
      if (cameFrom && body && cameFrom.id !== body.id) return null;
      return {
        kind: "while_statement",
        text: text(node.childForFieldName("condition")),
        negated: false,
        line,
      };
    }
    case "except_clause":
      return { kind: "except_clause", text: text(node.namedChild(0)), negated: false, line };
    case "finally_clause":
      return { kind: "finally_clause", text: null, negated: false, line };
    case "with_statement":
      return {
        kind: "with_statement",
        text: text(node.childForFieldName("body") ? node.namedChild(0) : null),
        negated: false,
        line,
      };
    case "case_clause":
      return { kind: "case_clause", text: text(node.namedChild(0)), negated: false, line };
    case "conditional_expression": {
      // `a() if cond else b()` -- which arm did we come from?
      const parts = node.namedChildren.filter((c): c is Node => c !== null);
      const cond = parts[1] ? text(parts[1]) : null;
      const negated = Boolean(cameFrom && parts[2] && cameFrom.id === parts[2].id);
      return { kind: "conditional_expression", text: cond, negated, line };
    }
    default:
      return null;
  }
}

export class BranchIndex {
  #trees = new Map<string, Tree>();
  #root: string;
  #parser: Parser;

  private constructor(root: string, parser: Parser) {
    this.#root = root;
    this.#parser = parser;
  }

  static async create(root: string): Promise<BranchIndex> {
    return new BranchIndex(canonical(root), await getParser());
  }

  /** Parse and cache a file's tree. `text` overrides reading from disk. */
  load(file: string, source?: string): Tree {
    const existing = this.#trees.get(file);
    if (existing) return existing;
    const content = source ?? readFileSync(path.resolve(this.#root, file), "utf8");
    const tree = this.#parser.parse(content);
    if (!tree) throw new Error(`tree-sitter failed to parse ${file}`);
    this.#trees.set(file, tree);
    return tree;
  }

  /**
   * Guards enclosing the given call-site range, outermost first.
   * The range comes from the language server's `fromRanges`.
   */
  conditionsAt(file: string, range: Range): Condition[] {
    const tree = this.load(file);
    const start = tree.rootNode.descendantForPosition({
      row: range.start.line,
      column: range.start.character,
    });
    if (!start) return [];

    const out: Condition[] = [];
    let cur: Node | null = start;
    let prev: Node | null = null;
    while (cur) {
      // Stop at the enclosing function: guards belong to the caller's body.
      if (cur.type === "function_definition" && prev !== null) break;
      const g = guardFor(cur, prev);
      if (g) out.push(g);
      prev = cur;
      cur = cur.parent;
    }
    return out.reverse(); // outermost first
  }

  /**
   * The definition enclosing a position, with its dotted qualified name and
   * its full source text.
   *
   * Both matter for identity: the language server's CallHierarchyItem.range is
   * too narrow to hash a body from, and a line-numbered id renumbers every
   * symbol below an inserted line.
   */
  definitionAt(
    file: string,
    position: { line: number; character: number },
    source?: string,
  ): {
    qualifiedName: string;
    /** Full definition text, signature included. */
    text: string;
    /** Implementation body only, signature excluded. */
    blockText: string;
    startLine: number;
    endLine: number;
  } | null {
    const tree = this.load(file, source);
    let node: Node | null = tree.rootNode.descendantForPosition({
      row: position.line,
      column: position.character,
    });
    if (!node) return null;

    const parts: string[] = [];
    let self: Node | null = null;
    while (node) {
      if (node.type === "function_definition" || node.type === "class_definition") {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          parts.push(name);
          self ??= node;
        }
      }
      node = node.parent;
    }
    if (!self || parts.length === 0) return null;
    return {
      qualifiedName: parts.reverse().join("."),
      text: self.text,
      // The body alone. Identity must survive a rename, and the name lives in
      // the signature -- hashing the whole definition makes every rename look
      // like a new symbol.
      blockText: self.childForFieldName("body")?.text ?? "",
      startLine: self.startPosition.row,
      endLine: self.endPosition.row,
    };
  }

  dispose(): void {
    for (const t of this.#trees.values()) t.delete();
    this.#trees.clear();
  }
}
