import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type JsonValue = unknown;

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: JsonValue;
  constructor(code: number, message: string, data?: JsonValue) {
    super(`LSP error ${code}: ${message}`);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** Handles a request sent by the server to us. Return the `result` value. */
export type ServerRequestHandler = (method: string, params: JsonValue) => JsonValue;

/**
 * JSON-RPC over stdio with LSP `Content-Length` framing.
 *
 * Correlates responses by id. Messages that are not the response we are waiting
 * for (notifications, and requests originating from the server) are dispatched
 * rather than mistaken for a result -- reading the first message off the stream
 * and assuming it is the response is a real and easy mistake, and it silently
 * yields an empty capability set.
 */
export class JsonRpcClient {
  #proc: ChildProcessWithoutNullStreams;
  #buf: Buffer = Buffer.alloc(0);
  #nextId = 0;
  #pending = new Map<
    number,
    { resolve: (v: JsonValue) => void; reject: (e: Error) => void }
  >();
  #notificationHandlers = new Map<string, (params: JsonValue) => void>();
  #serverRequestHandler: ServerRequestHandler | null = null;
  #closed = false;
  #exitError: Error | null = null;

  constructor(proc: ChildProcessWithoutNullStreams) {
    this.#proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    proc.on("exit", (code, signal) => {
      this.#closed = true;
      this.#exitError = new Error(
        `language server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      for (const { reject } of this.#pending.values()) reject(this.#exitError);
      this.#pending.clear();
    });
  }

  onNotification(method: string, handler: (params: JsonValue) => void): void {
    this.#notificationHandlers.set(method, handler);
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(method: string, params?: JsonValue): Promise<JsonValue> {
    if (this.#closed) {
      return Promise.reject(this.#exitError ?? new Error("client is closed"));
    }
    const id = ++this.#nextId;
    return new Promise<JsonValue>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: JsonValue): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #write(msg: RpcMessage): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.#proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.#proc.stdin.write(body);
  }

  #onData(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const sep = this.#buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const header = this.#buf.subarray(0, sep).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match?.[1]) {
        // Unparseable header: drop it rather than spin forever on the same bytes.
        this.#buf = this.#buf.subarray(sep + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = sep + 4;
      if (this.#buf.length < start + length) return; // wait for more
      const body = this.#buf.subarray(start, start + length).toString("utf8");
      this.#buf = this.#buf.subarray(start + length);
      let msg: RpcMessage;
      try {
        msg = JSON.parse(body) as RpcMessage;
      } catch {
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: RpcMessage): void {
    // A response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.#pending.get(msg.id as number);
      if (!entry) return;
      this.#pending.delete(msg.id as number);
      if (msg.error) {
        entry.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        entry.resolve(msg.result ?? null);
      }
      return;
    }
    // A request from the server. It blocks until answered, so always answer.
    if (msg.id !== undefined && msg.method !== undefined) {
      let result: JsonValue = null;
      try {
        result = this.#serverRequestHandler?.(msg.method, msg.params ?? null) ?? null;
      } catch {
        result = null;
      }
      this.#write({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    // A notification.
    if (msg.method !== undefined) {
      this.#notificationHandlers.get(msg.method)?.(msg.params ?? null);
    }
  }
}
