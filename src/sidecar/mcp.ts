import { FlowService } from "../flow/service.ts";
import { CurationError, isConfidence, type Confidence } from "../flow/judgments.ts";
import { flowView } from "../views/index.ts";

/**
 * The agent surface: curation over the Model Context Protocol.
 *
 * This holds no model credential, makes no request to a provider, and runs no
 * agent loop. It exposes a capability; the agent that uses it is the user's own
 * Claude Code session (design D1). That is also what makes the map a shared
 * artifact rather than a report -- the agent resolves a hole, and the canvas
 * the human is already looking at updates.
 *
 * The transport is written here rather than taken from the SDK. The protocol
 * surface a stdio server needs is `initialize`, `tools/list` and `tools/call`
 * over newline-delimited JSON-RPC, which is a smaller problem than the LSP
 * framing this repository already implements by hand -- and the SDK brings an
 * HTTP stack, a CORS layer and an OAuth library into a process that never opens
 * a socket. Dispatch below is a pure function of a message, so swapping the
 * transport later touches nothing but the last thirty lines of this file.
 */

/** The protocol revision this server implements. */
export const PROTOCOL_VERSION = "2025-06-18";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) {
    throw new CurationError(`'${key}' is required and must be a non-empty string`);
  }
  return v;
}

function optional(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === "string" && v ? v : null;
}

function confidenceOf(args: Record<string, unknown>): Confidence | null {
  const v = args["confidence"];
  if (v === undefined || v === null) return null;
  if (!isConfidence(v)) {
    throw new CurationError(`'confidence' must be one of: certain, likely, guess`);
  }
  return v;
}

/**
 * The tools, as plain functions over a FlowService.
 *
 * Separated from the transport so every one of them can be called directly in
 * a test, with no agent and no protocol in the way.
 */
export function curationTools(service: FlowService): ToolDefinition[] {
  const flowArg = {
    flow: { type: "string", description: "Name of the declared flow." },
  };
  const holeArg = {
    hole: {
      type: "string",
      description: "Hole id from list_holes (its call site id is also accepted).",
    },
  };

  return [
    {
      name: "list_flows",
      description:
        "List the flows in this repository, with how many dispatches are still " +
        "unresolved and how many carry a judgment.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: () => {
        const flows = service.names().map((name) => {
          const stored = service.stored(name);
          if (!stored) return { flow: name, analyzed: false };
          const view = flowView(stored);
          return {
            flow: name,
            analyzed: true,
            entryPoint: stored.entryPoint,
            nodes: view.counts.nodes,
            edges: view.counts.edges,
            openHoles: view.counts.holes,
            judged: view.counts.judged,
            staleJudgments: view.counts.staleJudgments,
          };
        });
        return { flows };
      },
    },

    {
      name: "analyze_flow",
      description:
        "Re-derive a flow's facts from source and store them. Judgments already " +
        "recorded are carried forward untouched; this never creates one.",
      inputSchema: {
        type: "object",
        properties: flowArg,
        required: ["flow"],
      },
      handler: async (args) => {
        const name = str(args, "flow");
        const flow = await service.refresh(name);
        const view = flowView(flow);
        return {
          flow: name,
          nodes: view.counts.nodes,
          edges: view.counts.edges,
          openHoles: view.counts.holes,
          judged: view.counts.judged,
        };
      },
    },

    {
      name: "list_holes",
      description:
        "The unresolved dispatches of a flow. Each carries its declared target " +
        "and its candidate implementations in a stable order; resolve_dispatch " +
        "takes the `index` of the candidate you choose. A hole that already " +
        "carries a judgment reports it under `judgment`, including a decline -- " +
        "answer those again only when the state is not `current`.",
      inputSchema: {
        type: "object",
        properties: flowArg,
        required: ["flow"],
      },
      handler: (args) => {
        const name = str(args, "flow");
        const holes = service.holes(name);
        return {
          flow: name,
          open: holes.filter((h) => h.judgment === null || h.judgment.state !== "current").length,
          holes,
        };
      },
    },

    {
      name: "resolve_dispatch",
      description:
        "Record which implementation actually runs at a dispatch, naming it by " +
        "its position in that hole's candidate list. An index outside the list " +
        "is refused. If you cannot tell, call decline_dispatch instead -- a " +
        "wrong resolution is worse than an open hole, because it looks settled.\n\n" +
        "The candidate list is derived from the language server and is NOT " +
        "guaranteed complete: implementations reached through an intermediate " +
        "subclass are known to be missing from it. Read the code before " +
        "answering, and if the implementation that actually runs is not in the " +
        "list, decline with that as the reason rather than picking the nearest " +
        "entry.",
      inputSchema: {
        type: "object",
        properties: {
          ...flowArg,
          ...holeArg,
          candidate: {
            type: "integer",
            description: "0-based index into the hole's candidates.",
            minimum: 0,
          },
          confidence: {
            type: "string",
            enum: ["certain", "likely", "guess"],
            description: "How sure this is. Be honest; it is shown to the reviewer.",
          },
          note: {
            type: "string",
            description: "Why this candidate. The evidence, not the conclusion.",
          },
          by: { type: "string", description: "Who is recording this. Defaults to 'agent'." },
        },
        required: ["flow", "hole", "candidate"],
      },
      handler: (args) => {
        const raw = args["candidate"];
        const index = typeof raw === "number" ? raw : Number.NaN;
        const { judgment, holeId } = service.resolveDispatch(
          str(args, "flow"),
          str(args, "hole"),
          index,
          {
            by: optional(args, "by") ?? "agent",
            note: optional(args, "note"),
            confidence: confidenceOf(args),
          },
        );
        return { recorded: true, hole: holeId, judgment };
      },
    },

    {
      name: "decline_dispatch",
      description:
        "Record that a hole was considered and cannot be resolved, with the " +
        "reason. This is a real answer: it stops the hole being re-asked and " +
        "tells the reviewer it was thought about rather than skipped.",
      inputSchema: {
        type: "object",
        properties: {
          ...flowArg,
          ...holeArg,
          reason: {
            type: "string",
            description: "Why the call site does not determine an implementation.",
          },
          by: { type: "string", description: "Who is recording this. Defaults to 'agent'." },
        },
        required: ["flow", "hole", "reason"],
      },
      handler: (args) => {
        const { judgment, holeId } = service.declineDispatch(
          str(args, "flow"),
          str(args, "hole"),
          str(args, "reason"),
          { by: optional(args, "by") ?? "agent" },
        );
        return { recorded: true, hole: holeId, judgment };
      },
    },

    {
      name: "withdraw_judgment",
      description:
        "Remove a recorded judgment, returning the hole to its unresolved state " +
        "and its edge to the declared target.",
      inputSchema: {
        type: "object",
        properties: { ...flowArg, ...holeArg },
        required: ["flow", "hole"],
      },
      handler: (args) => {
        const { siteId } = service.withdrawJudgment(str(args, "flow"), str(args, "hole"));
        return { withdrawn: true, site: siteId };
      },
    },
  ];
}

// --------------------------------------------------------------- protocol ---

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class McpServer {
  readonly service: FlowService;
  readonly tools: Map<string, ToolDefinition>;
  readonly name: string;
  readonly version: string;

  constructor(service: FlowService, opts: { name?: string; version?: string } = {}) {
    this.service = service;
    this.tools = new Map(curationTools(service).map((t) => [t.name, t]));
    this.name = opts.name ?? "enchanted-map";
    this.version = opts.version ?? "0.1.0";
  }

  /** Call one tool by name. The path a test takes, with no protocol in the way. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new CurationError(`unknown tool: ${name}`);
    return await tool.handler(args);
  }

  /**
   * Handle one message. Returns null for a notification, which has no reply.
   *
   * A failing tool comes back as a result with `isError`, not as a protocol
   * error: the agent has to be able to read "candidate 7 is outside this hole,
   * which has 2: 0=… 1=…" and try again. A transport-level error would just
   * look like the tool is broken.
   */
  async handle(msg: JsonRpcMessage): Promise<Record<string, unknown> | null> {
    const { method, id } = msg;
    const isNotification = id === undefined || id === null;

    const reply = (result: unknown): Record<string, unknown> | null =>
      isNotification ? null : { jsonrpc: "2.0", id, result };
    const fail = (code: number, message: string): Record<string, unknown> | null =>
      isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } };

    switch (method) {
      case "initialize": {
        // Echo the client's revision when it names one: this server's surface
        // is stable across the revisions that have it, and refusing a version
        // we would have spoken correctly helps nobody.
        const asked = msg.params?.["protocolVersion"];
        return reply({
          protocolVersion: typeof asked === "string" && asked ? asked : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.version },
        });
      }

      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      case "ping":
        return reply({});

      case "tools/list":
        return reply({
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call": {
        const name = String(msg.params?.["name"] ?? "");
        const args = (msg.params?.["arguments"] ?? {}) as Record<string, unknown>;
        try {
          const result = await this.call(name, args);
          return reply({
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as Record<string, unknown>,
            isError: false,
          });
        } catch (e) {
          return reply({
            content: [{ type: "text", text: (e as Error).message }],
            isError: true,
          });
        }
      }

      default:
        return fail(-32601, `method not found: ${method ?? "(none)"}`);
    }
  }
}

/**
 * Newline-delimited JSON-RPC over stdio, which is what an MCP client spawns.
 *
 * Nothing may be written to stdout but protocol messages: a stray log line
 * corrupts the stream and the client simply disconnects, which is a miserable
 * thing to debug. Diagnostics go to stderr.
 */
export function serveMcpStdio(
  server: McpServer,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  let buffer = "";
  /**
   * Messages are handled strictly in arrival order, one at a time.
   *
   * Not for the protocol's sake -- JSON-RPC correlates by id and tolerates any
   * order -- but because recording a judgment is a read-modify-write of a flow
   * file. Two tool calls in flight at once would each read the same file and
   * the second write would silently drop the first decision.
   */
  let queue: Promise<void> = Promise.resolve();

  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) queue = queue.then(() => respond(line));
    }
  });

  async function respond(line: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      output.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }) + "\n",
      );
      return;
    }
    try {
      const out = await server.handle(msg);
      if (out) output.write(JSON.stringify(out) + "\n");
    } catch (e) {
      if (msg.id !== undefined && msg.id !== null) {
        output.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: (e as Error).message },
          }) + "\n",
        );
      }
      process.stderr.write(`enchanted-map mcp: ${(e as Error).stack}\n`);
    }
  }
}
