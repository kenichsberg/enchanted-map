import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { JsonRpcClient, type JsonValue } from "./jsonrpc.ts";
import { canonical } from "../util/paths.ts";

/** Capabilities the analyzer cannot work without (design D2). */
export const REQUIRED_CAPABILITIES = [
  "callHierarchyProvider",
  "implementationProvider",
] as const;

export class MissingCapabilityError extends Error {
  readonly missing: string[];
  readonly command: string[];
  constructor(missing: string[], command: string[]) {
    super(
      `language server lacks required capabilities [${missing.join(", ")}]. ` +
        `Attempted command: ${command.join(" ")}. ` +
        `basedpyright is required; pyright does not implement textDocument/implementation.`,
    );
    this.name = "MissingCapabilityError";
    this.missing = missing;
    this.command = command;
  }
}

export class ServerStartError extends Error {
  readonly command: string[];
  constructor(message: string, command: string[]) {
    super(`${message}. Attempted command: ${command.join(" ")}`);
    this.name = "ServerStartError";
    this.command = command;
  }
}

/** Resolve the basedpyright language server command, preferring the local install. */
export function resolveServerCommand(override?: string[]): string[] {
  if (override && override.length > 0) return override;
  const local = path.resolve(
    import.meta.dirname,
    "../../node_modules/.bin/basedpyright-langserver",
  );
  if (existsSync(local)) return [local, "--stdio"];
  return ["basedpyright-langserver", "--stdio"];
}

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  uri: string;
  range: Range;
}

export class LanguageServer {
  readonly root: string;
  readonly command: string[];
  #proc: ChildProcessWithoutNullStreams | null = null;
  #client: JsonRpcClient | null = null;
  #opened = new Set<string>();
  #capabilities: Record<string, JsonValue> = {};
  #cleanup: (() => void) | null = null;
  /** Number of requests issued, per method. Lets tests assert on cache hits. */
  readonly requestCounts = new Map<string, number>();

  constructor(root: string, commandOverride?: string[]) {
    this.root = canonical(root);
    this.command = resolveServerCommand(commandOverride);
  }

  get capabilities(): Record<string, JsonValue> {
    return this.#capabilities;
  }

  #requireClient(): JsonRpcClient {
    if (!this.#client) throw new Error("language server is not started");
    return this.#client;
  }

  uriFor(file: string): string {
    return pathToFileURL(path.resolve(this.root, file)).href;
  }

  async start(): Promise<void> {
    const [bin, ...args] = this.command;
    if (!bin) throw new ServerStartError("empty server command", this.command);

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], cwd: this.root });
    } catch (e) {
      throw new ServerStartError(
        `failed to spawn language server: ${(e as Error).message}`,
        this.command,
      );
    }
    const spawnFailure = new Promise<never>((_, reject) => {
      proc.once("error", (e) =>
        reject(new ServerStartError(`failed to spawn language server: ${e.message}`, this.command)),
      );
    });
    this.#proc = proc;
    proc.stderr.resume(); // drain so the server never blocks on a full pipe

    // No orphans: kill the child if this process goes away for any reason (spec 2.2).
    const kill = () => {
      if (this.#proc && this.#proc.exitCode === null) this.#proc.kill("SIGKILL");
    };
    process.once("exit", kill);
    process.once("SIGINT", kill);
    process.once("SIGTERM", kill);
    this.#cleanup = () => {
      process.removeListener("exit", kill);
      process.removeListener("SIGINT", kill);
      process.removeListener("SIGTERM", kill);
    };

    const client = new JsonRpcClient(proc);
    this.#client = client;

    // The server blocks on these; answering with defaults keeps initialize moving.
    client.onServerRequest((method, params) => {
      if (method === "workspace/configuration") {
        const items = (params as { items?: unknown[] } | null)?.items ?? [];
        return items.map(() => ({}));
      }
      return null;
    });

    const result = (await Promise.race([
      client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        rootPath: this.root,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            callHierarchy: { dynamicRegistration: false },
            implementation: { dynamicRegistration: false, linkSupport: false },
            definition: { dynamicRegistration: false, linkSupport: false },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { workspaceFolders: true, configuration: true },
        },
        initializationOptions: {},
      }),
      spawnFailure,
    ])) as { capabilities?: Record<string, JsonValue> } | null;

    this.#capabilities = result?.capabilities ?? {};

    const missing = REQUIRED_CAPABILITIES.filter((c) => !this.#capabilities[c]);
    if (missing.length > 0) {
      await this.stop();
      throw new MissingCapabilityError(missing, this.command);
    }

    client.notify("initialized", {});
  }

  /** Open a document so the server analyses it (spec 2.4). Idempotent. */
  openDocument(file: string, text?: string): string {
    const abs = path.resolve(this.root, file);
    const uri = pathToFileURL(abs).href;
    if (this.#opened.has(uri)) return uri;
    const content = text ?? readFileSync(abs, "utf8");
    this.#requireClient().notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "python", version: 1, text: content },
    });
    this.#opened.add(uri);
    return uri;
  }

  get openedDocuments(): ReadonlySet<string> {
    return this.#opened;
  }

  /** Rejects rather than throwing synchronously, so `.catch()` callers see it. */
  request(method: string, params: JsonValue): Promise<JsonValue> {
    if (!this.#client) {
      return Promise.reject(new Error("language server is not started"));
    }
    this.requestCounts.set(method, (this.requestCounts.get(method) ?? 0) + 1);
    return this.#client.request(method, params);
  }

  async stop(): Promise<void> {
    const client = this.#client;
    const proc = this.#proc;
    this.#client = null;
    this.#proc = null;
    this.#opened.clear();
    if (client && !client.closed) {
      try {
        await Promise.race([
          client.request("shutdown"),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
        client.notify("exit");
      } catch {
        // server already gone; fall through to kill
      }
    }
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    this.#cleanup?.();
    this.#cleanup = null;
  }
}
