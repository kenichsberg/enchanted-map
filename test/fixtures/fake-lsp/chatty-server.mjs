// A deliberately awkward LSP server: before answering `initialize` it sends a
// notification AND a server->client request. A client that reads the first
// message off the stream and calls it the response will see empty capabilities.
let buf = Buffer.alloc(0);
const write = (msg) => {
  const b = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`);
  process.stdout.write(b);
};
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString("utf8"));
    buf = buf.subarray(sep + 4 + len);
    if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "hi" } });
      write({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{}, {}] } });
      write({
        jsonrpc: "2.0", id: msg.id,
        result: { capabilities: { callHierarchyProvider: true, implementationProvider: true } },
      });
    } else if (msg.method === "shutdown") {
      write({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "exit") {
      process.exit(0);
    } else if (msg.method === "echo") {
      write({ jsonrpc: "2.0", id: msg.id, result: { got: msg.params } });
    }
  }
});
