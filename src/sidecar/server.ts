import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FlowService } from "../flow/service.ts";
import { flowView, diffView, stalenessView, provenanceView } from "../views/index.ts";
import { canonical } from "../util/paths.ts";

/**
 * The sidecar: one long-lived process holding the language server, serving
 * both surfaces.
 *
 * Neovim speaks newline-delimited JSON over stdio and owns the process
 * lifetime. The browser speaks HTTP to the same instance. Both consume the
 * same view objects (design D13), so neither can drift from the other.
 */

export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JumpTarget {
  file: string;
  line: number;
  character: number;
  /** The project the file is relative to. The sidecar's root is authoritative. */
  root: string;
}

export type JumpListener = (target: JumpTarget) => void;

export class Sidecar {
  readonly service: FlowService;
  readonly root: string;
  #jumpListeners = new Set<JumpListener>();
  #sseClients = new Set<http.ServerResponse>();
  #http: http.Server | null = null;
  #port = 0;

  constructor(root: string) {
    this.root = canonical(root);
    this.service = new FlowService(root);
  }

  get port(): number {
    return this.#port;
  }

  onJump(fn: JumpListener): () => void {
    this.#jumpListeners.add(fn);
    return () => this.#jumpListeners.delete(fn);
  }

  /** Dispatch one RPC call. Shared by the stdio loop and the HTTP layer. */
  async handle(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const name = typeof params["flow"] === "string" ? params["flow"] : "";
    switch (method) {
      case "ping":
        return { ok: true, root: this.root, port: this.#port };

      case "flows":
        return { flows: this.service.names() };

      case "declare": {
        const { declareEntryPoint } = await import("../flow/config.ts");
        const config = declareEntryPoint(this.root, {
          name: String(params["name"]),
          file: String(params["file"]),
          symbol: String(params["symbol"]),
        });
        return { entryPoints: config.entryPoints };
      }

      case "analyze": {
        const flow = await this.service.refresh(name);
        this.broadcast("flow", { flow: name });
        return flowView(flow);
      }

      case "view": {
        const lens = String(params["lens"] ?? "flow");
        const status = await this.service.status(name);
        // A stored flow that predates the current model would render without
        // ordering or nesting and look simply wrong. Prefer the fresh analysis,
        // which already carries the stored flow's curation forward.
        const usableStored =
          status.stored && !status.stored.legacy ? status.stored : null;
        const stored = usableStored ?? status.current ?? status.stored;
        if (!stored) {
          // status() captures the real failure; reporting "not analyzed"
          // instead hides it and sends the user looking in the wrong place.
          if (status.error) throw new Error(status.error);
          throw new Error(
            `flow '${name}' has not been analyzed yet (root: ${this.root})`,
          );
        }
        if (lens === "diff") {
          if (!status.current) throw new Error(`cannot analyze '${name}'`);
          return diffView(stored, status.current);
        }
        if (lens === "stale") {
          if (!status.report) throw new Error(`no stored flow for '${name}'`);
          return stalenessView(stored, status.report);
        }
        if (lens === "provenance") return provenanceView(stored);
        return flowView(stored, status.report);
      }

      case "accept": {
        const flow = this.service.accept(name);
        this.broadcast("flow", { flow: name });
        return flowView(flow);
      }

      case "jump": {
        const target: JumpTarget = {
          file: String(params["file"]),
          line: Number(params["line"] ?? 0),
          character: Number(params["character"] ?? 0),
          root: this.root,
        };
        for (const fn of this.#jumpListeners) fn(target);
        return { ok: true, target };
      }

      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  /**
   * Push an event to connected canvases.
   *
   * Server-sent events rather than WebSocket: the requirement is that the
   * canvas updates without a reload, and SSE does that with no dependency and
   * no handshake to implement. The browser talks back over ordinary POSTs.
   */
  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.#sseClients) {
      try {
        res.write(payload);
      } catch {
        this.#sseClients.delete(res);
      }
    }
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<number> {
    const server = http.createServer((req, res) => {
      void this.#onRequest(req, res);
    });
    this.#http = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    const addr = server.address();
    this.#port = typeof addr === "object" && addr ? addr.port : port;
    return this.#port;
  }

  async close(): Promise<void> {
    for (const res of this.#sseClients) res.end();
    this.#sseClients.clear();
    const server = this.#http;
    this.#http = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  async #onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      this.#sseClients.add(res);
      req.on("close", () => this.#sseClients.delete(res));
      return;
    }

    if (url.pathname === "/api" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const parsed = JSON.parse(body || "{}") as { method?: string; params?: Record<string, unknown> };
        const result = await this.handle(parsed.method ?? "", parsed.params ?? {});
        json(res, 200, { result });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return;
    }

    if (url.pathname === "/render.mjs") {
      const js = readFileSync(path.resolve(import.meta.dirname, "render.mjs"), "utf8");
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(js);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(path.resolve(import.meta.dirname, "canvas.html"), "utf8");
      // The page is read from disk per request; tell the browser not to cache
      // it either, so an edit is visible on reload while iterating.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/**
 * Newline-delimited JSON over stdio, for the editor.
 *
 * Neovim spawns this and kills it on exit, so there is no port to configure
 * and no daemon to leak.
 */
export function serveStdio(sidecar: Sidecar): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      void respond(line);
    }
  });

  async function respond(line: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      return;
    }
    try {
      const result = await sidecar.handle(req.method, req.params ?? {});
      write({ id: req.id, result });
    } catch (e) {
      write({ id: req.id, error: (e as Error).message });
    }
  }

  function write(msg: unknown): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  // A jump originating in the browser is pushed to the editor unsolicited.
  sidecar.onJump((target) => write({ id: 0, event: "jump", params: target }));
}
