#!/usr/bin/env node
import path from "node:path";
import { LanguageServer } from "./lsp/server.ts";
import { FlowService } from "./flow/service.ts";
import { declareEntryPoint } from "./flow/config.ts";
import {
  flowView,
  diffView,
  stalenessView,
  provenanceView,
  conditionLabel,
} from "./views/index.ts";
import { Sidecar, serveStdio } from "./sidecar/server.ts";
import { Extractor } from "./analysis/extract.ts";
import { BranchIndex } from "./analysis/branches.ts";
import { DispatchResolver } from "./analysis/dispatch.ts";
import type { FlowFacts } from "./analysis/types.ts";

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

const USAGE = `enchanted-map

Usage:
  enchanted-map facts <file> <symbol> [--root DIR] [--depth N] [--json]
      Dump deterministic facts for one symbol. No editor, no browser.

  enchanted-map declare <name> <file> <symbol> [--root DIR]
      Declare a flow entry point in project config.

  enchanted-map analyze <name> [--root DIR]
      Analyze a declared flow and write it to .enchanted/flows/<name>.yaml

  enchanted-map view <name> [--root DIR] [--lens flow|diff|stale|provenance] [--json]
      Render a view of a stored flow.

  enchanted-map accept <name> [--root DIR]
      Stamp the stored flow as accepted at the current revision.

  enchanted-map check [--root DIR] [--json]
      Report flow staleness. Writes no curation. Exits non-zero when drifted.

  enchanted-map serve [--root DIR] [--port N] [--stdio]
      Run the sidecar: HTTP canvas for the browser, stdio RPC for the editor.

  enchanted-map help
`;

function renderFacts(facts: FlowFacts): string {
  const out: string[] = [];
  // Disambiguate same-named methods on different classes (Sender.send vs
  // SMSSender.send) -- the bare name is useless exactly where it matters most.
  const counts = new Map<string, number>();
  for (const s of Object.values(facts.symbols)) {
    counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  }
  const sym = (id: string) => {
    const s = facts.symbols[id];
    if (!s) return id;
    if ((counts.get(s.name) ?? 0) <= 1) return s.name;
    const where = s.external ? `ext:${s.file.split("/").pop()}` : s.file;
    return `${s.name}<${where}:${s.selectionRange.start.line + 1}>`;
  };
  out.push(`root:     ${sym(facts.root)}  (${facts.root})`);
  out.push(`depth:    ${facts.maxDepth}`);
  out.push(`symbols:  ${Object.keys(facts.symbols).length}`);
  out.push(`edges:    ${facts.edges.length}`);
  out.push(`holes:    ${facts.unresolved.length}`);
  out.push("");
  out.push("edges (source order):");
  for (const e of facts.edges) {
    // Use the view layer's label rather than a second copy of the rule: this
    // dump had its own, so filtering context guards in one place left the
    // other showing them.
    const label = conditionLabel(e.site.conditions);
    const cond = label ? `  [${label}]` : "";
    const marks = [
      e.closesCycle ? "cycle" : null,
      e.provenance !== "lsp-verified" ? e.provenance : null,
      e.declaredTarget ? `declared=${sym(e.declaredTarget)}` : null,
      e.candidates.length > 0 ? `${e.candidates.length} candidates` : null,
    ]
      .filter(Boolean)
      .join(",");
    const nest =
      e.site.kind === "argument"
        ? `  argument of -> ${facts.edges.find((o) => o.id === e.site.enclosingSite)?.to.split("#").pop() ?? "?"}`
        : "";
    out.push(
      `  ${String(e.site.ordinal).padStart(2)}. ${sym(e.from)} -> ${sym(e.to)}` +
        `  @${e.site.file}:${e.site.range.start.line + 1}${cond}${nest}` +
        (marks ? `  (${marks})` : ""),
    );
  }
  if (facts.unresolved.length > 0) {
    out.push("");
    out.push("holes:");
    for (const h of facts.unresolved) {
      out.push(
        `  ${sym(h.declaredTarget)}  reason=${h.reason}  ` +
          `candidates=[${h.candidates.map((c) => `${c.file}:${c.name}@${c.selectionRange.start.line + 1}`).join(", ")}]`,
      );
    }
  }
  if (facts.external.length > 0) {
    out.push("");
    out.push(`external (not expanded): ${facts.external.map(sym).join(", ")}`);
  }
  if (facts.truncated.length > 0) {
    out.push("");
    out.push(`truncated at depth ${facts.maxDepth}: ${facts.truncated.map(sym).join(", ")}`);
  }
  if (facts.cycles.length > 0) {
    out.push(`cycles: ${facts.cycles.map(sym).join(", ")}`);
  }
  return out.join("\n");
}

async function cmdFacts(args: Args): Promise<number> {
  const [file, symbol] = args.positional;
  if (!file || !symbol) {
    process.stderr.write("error: facts requires <file> and <symbol>\n\n" + USAGE);
    return 2;
  }
  const root = path.resolve(String(args.flags["root"] ?? process.cwd()));
  const depth = Number(args.flags["depth"] ?? 3);

  const server = new LanguageServer(root);
  await server.start();
  try {
    const branches = await BranchIndex.create(root);
    const ex = new Extractor(server, branches);
    const pos = await locate(server, file, symbol);
    if (!pos) {
      process.stderr.write(`error: no symbol named '${symbol}' in ${file}\n`);
      return 1;
    }
    const rootRef = await ex.prepare(file, pos.line, pos.character);
    if (!rootRef) {
      process.stderr.write(`error: could not resolve a call hierarchy item at ${symbol}\n`);
      return 1;
    }
    const facts = await ex.traverse(rootRef, { maxDepth: depth });
    if (!args.flags["no-dispatch"]) {
      await new DispatchResolver(server, ex).annotate(facts);
    }
    process.stdout.write(
      args.flags["json"] ? JSON.stringify(facts, null, 2) + "\n" : renderFacts(facts) + "\n",
    );
    return 0;
  } finally {
    await server.stop();
  }
}

/** Find a top-level symbol by name using documentSymbol. */
async function locate(
  server: LanguageServer,
  file: string,
  name: string,
): Promise<{ line: number; character: number } | null> {
  const uri = server.openDocument(file);
  const syms = (await server.request("textDocument/documentSymbol", {
    textDocument: { uri },
  })) as Array<{
    name: string;
    selectionRange?: { start: { line: number; character: number } };
    location?: { range: { start: { line: number; character: number } } };
    children?: unknown[];
  }> | null;

  const walk = (
    nodes: typeof syms,
  ): { line: number; character: number } | null => {
    for (const s of nodes ?? []) {
      if (s.name === name) {
        const p = s.selectionRange?.start ?? s.location?.range.start;
        if (p) return p;
      }
      const inner = walk((s.children ?? null) as typeof syms);
      if (inner) return inner;
    }
    return null;
  };
  return walk(syms);
}

function rootOf(args: Args): string {
  return path.resolve(String(args.flags["root"] ?? process.cwd()));
}

async function cmdDeclare(args: Args): Promise<number> {
  const [name, file, symbol] = args.positional;
  if (!name || !file || !symbol) {
    process.stderr.write("error: declare requires <name> <file> <symbol>\n\n" + USAGE);
    return 2;
  }
  const config = declareEntryPoint(rootOf(args), { name, file, symbol });
  process.stdout.write(
    `declared '${name}' -> ${file}:${symbol}  (${config.entryPoints.length} entry points)\n`,
  );
  return 0;
}

async function cmdAnalyze(args: Args): Promise<number> {
  const [name] = args.positional;
  if (!name) {
    process.stderr.write("error: analyze requires <name>\n\n" + USAGE);
    return 2;
  }
  const svc = new FlowService(rootOf(args));
  const flow = await svc.refresh(name);
  process.stdout.write(
    `analyzed '${flow.name}': ${flow.nodes.length} nodes, ${flow.edges.length} edges, ` +
      `${flow.holes.length} holes\n`,
  );
  return 0;
}

async function cmdView(args: Args): Promise<number> {
  const [name] = args.positional;
  if (!name) {
    process.stderr.write("error: view requires <name>\n\n" + USAGE);
    return 2;
  }
  const root = rootOf(args);
  const svc = new FlowService(root);
  const lens = String(args.flags["lens"] ?? "flow");
  const status = await svc.status(name);
  const usableStored = status.stored && !status.stored.legacy ? status.stored : null;
  const stored = usableStored ?? status.current ?? status.stored;
  if (!stored) {
    process.stderr.write(
      status.error
        ? `error: ${status.error}\n`
        : `error: flow '${name}' has not been analyzed yet (root: ${root})\n`,
    );
    return 1;
  }

  let view: unknown;
  if (lens === "diff") {
    if (!status.current) {
      process.stderr.write(`error: cannot analyze '${name}' to diff against\n`);
      return 1;
    }
    view = diffView(stored, status.current);
  } else if (lens === "stale") {
    if (!status.report) {
      process.stderr.write(`error: no stored flow to compare '${name}' against\n`);
      return 1;
    }
    view = stalenessView(stored, status.report);
  } else if (lens === "provenance") {
    view = provenanceView(stored);
  } else {
    view = flowView(stored, status.report);
  }

  process.stdout.write(
    args.flags["json"] ? JSON.stringify(view, null, 2) + "\n" : renderView(view) + "\n",
  );
  return 0;
}

function renderView(view: unknown): string {
  const v = view as Record<string, unknown>;
  const out: string[] = [];
  if (v["kind"] === "flow") {
    const f = view as ReturnType<typeof flowView>;
    const label = (id: string) => f.nodes.find((n) => n.id === id)?.label ?? id;
    out.push(`flow ${f.flow}  [${f.acceptance}]  depth=${f.maxDepth}`);
    out.push(
      `  ${f.counts.nodes} nodes, ${f.counts.edges} edges, ${f.counts.holes} holes, ` +
        `${f.counts.stale} stale`,
    );
    out.push("");
    out.push("  calls in source order; indented calls are arguments of the call above");
    out.push("");
    for (const e of f.edges) {
      const cond = e.conditionLabel ? `  [${e.conditionLabel}]` : "";
      const marks = [
        e.provenance !== "lsp-verified" ? e.provenance : null,
        e.closesCycle ? "cycle" : null,
        e.stale ? `stale:${e.staleReasons.join("/")}` : null,
      ].filter(Boolean);
      const indent = "    ".repeat(e.nestingDepth);
      const arg = e.kind === "argument" ? "  <- argument, evaluated first" : "";
      out.push(
        `  ${String(e.ordinal).padStart(2)}. ${indent}${label(e.from)} -> ${label(e.to)}` +
          `${cond}${arg}` +
          (marks.length ? `  (${marks.join(",")})` : ""),
      );
    }
    const truncated = f.nodes.filter((n) => n.truncated).map((n) => n.label);
    if (truncated.length) out.push(`\n  truncated: ${truncated.join(", ")}`);
    const cycles = f.nodes.filter((n) => n.cycle).map((n) => n.label);
    if (cycles.length) out.push(`  cycles: ${cycles.join(", ")}`);
    for (const h of f.holes) {
      out.push(`  hole @${h.siteId}  reason=${h.reason}  candidates=${h.candidates.length}`);
    }
  } else if (v["kind"] === "diff") {
    const d = view as ReturnType<typeof diffView>;
    if (d.empty) return `flow ${d.flow}: no structural change`;
    out.push(`flow ${d.flow} vs ${d.against}`);
    for (const n of d.addedNodes) out.push(`  + node ${n.label}  ${n.file}:${n.line + 1}`);
    for (const n of d.removedNodes) out.push(`  - node ${n.label}`);
    for (const e of d.addedEdges) out.push(`  + edge ${e.id}${e.conditionLabel ? ` [${e.conditionLabel}]` : ""}`);
    for (const e of d.removedEdges) out.push(`  - edge ${e.id}`);
    for (const c of d.conditionChanged) out.push(`  ~ guard ${c.edge.id}: ${c.before} -> ${c.after}`);
  } else if (v["kind"] === "staleness") {
    const s2 = view as ReturnType<typeof stalenessView>;
    if (!s2.stale) return `flow ${s2.flow}: current`;
    out.push(`flow ${s2.flow}: ${s2.entries.length} stale entries`);
    for (const e of s2.entries) out.push(`  ${e.kind} ${e.reason}  ${e.label}`);
  } else if (v["kind"] === "provenance") {
    const p2 = view as ReturnType<typeof provenanceView>;
    out.push(`flow ${p2.flow}`);
    for (const [tier, ids] of Object.entries(p2.tiers)) {
      out.push(`  ${tier}: ${ids.length}`);
    }
    for (const u of p2.unresolved) {
      out.push(`  unresolved ${u.edgeId} -> ${u.declaredTarget}  (${u.candidates.length} candidates)`);
    }
  }
  return out.join("\n");
}

async function cmdAccept(args: Args): Promise<number> {
  const [name] = args.positional;
  if (!name) {
    process.stderr.write("error: accept requires <name>\n\n" + USAGE);
    return 2;
  }
  const flow = new FlowService(rootOf(args)).accept(name);
  process.stdout.write(`accepted '${flow.name}' at ${flow.accepted?.revision}\n`);
  return 0;
}

/**
 * CI check: reports drift, never curates (design: CI checks, humans curate).
 */
async function cmdCheck(args: Args): Promise<number> {
  const svc = new FlowService(rootOf(args));
  const statuses = await svc.statusAll();
  if (statuses.length === 0) {
    process.stdout.write("no flows declared\n");
    return 0;
  }

  const drifted = statuses.filter((s) => s.report?.stale || s.broken || s.error);
  if (args.flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        statuses.map((s) => ({
          flow: s.name,
          broken: s.broken,
          error: s.error,
          stale: s.report?.stale ?? false,
          entries: s.report?.entries ?? [],
        })),
        null,
        2,
      ) + "\n",
    );
  } else {
    for (const s of statuses) {
      if (s.broken) {
        process.stdout.write(`BROKEN  ${s.name}: ${s.error}\n`);
      } else if (s.error) {
        process.stdout.write(`ERROR   ${s.name}: ${s.error}\n`);
      } else if (!s.stored) {
        process.stdout.write(`NEW     ${s.name}: not yet stored\n`);
      } else if (s.report?.stale) {
        process.stdout.write(`STALE   ${s.name}: ${s.report.entries.length} entries\n`);
        for (const e of s.report.entries.slice(0, 20)) {
          process.stdout.write(`          ${e.kind} ${e.reason}  ${e.affects}\n`);
        }
      } else {
        process.stdout.write(`ok      ${s.name}\n`);
      }
    }
  }
  return drifted.length > 0 ? 1 : 0;
}

async function cmdServe(args: Args): Promise<number> {
  const root = rootOf(args);
  const sidecar = new Sidecar(root);

  // The browser surface is optional. If the canvas cannot bind a port, the
  // editor must still work -- it does not depend on the browser existing.
  let port: number | null = null;
  let bindError: string | null = null;
  try {
    port = await sidecar.listen(Number(args.flags["port"] ?? 0));
  } catch (e) {
    bindError = (e as Error).message;
  }

  if (args.flags["stdio"]) {
    // Neovim owns this process; it reads the announcement, then speaks RPC.
    serveStdio(sidecar);
    process.stdout.write(
      JSON.stringify({ id: 0, event: "ready", params: { port, root, bindError } }) + "\n",
    );
  } else {
    if (port === null) {
      process.stderr.write(`error: could not bind a port: ${bindError}\n`);
      return 1;
    }
    process.stdout.write(`enchanted-map sidecar listening on http://127.0.0.1:${port}\n`);
    process.stdout.write(`root: ${root}\n`);
  }
  await new Promise<void>(() => {}); // run until killed
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let code = 0;
  switch (args.cmd) {
    case "facts":
      code = await cmdFacts(args);
      break;
    case "declare":
      code = await cmdDeclare(args);
      break;
    case "analyze":
      code = await cmdAnalyze(args);
      break;
    case "view":
      code = await cmdView(args);
      break;
    case "accept":
      code = await cmdAccept(args);
      break;
    case "check":
      code = await cmdCheck(args);
      break;
    case "serve":
      code = await cmdServe(args);
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      break;
    default:
      process.stderr.write(`unknown command: ${args.cmd}\n\n${USAGE}`);
      code = 2;
  }
  process.exitCode = code;
}

await main();
