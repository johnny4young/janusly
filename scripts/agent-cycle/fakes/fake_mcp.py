"""A tiny Streamable HTTP MCP server with two Janusly-like tools, for the
harness self-test. Answers JSON, never SSE, like Janusly's /mcp."""

import http.server, json, sys, threading

TOOLS = [
    {"name": "workflows.list", "description": "List workflows", "inputSchema": {"type": "object"},
     "annotations": {"readOnlyHint": True, "destructiveHint": False}},
    {"name": "runs.cancel", "description": "Cancel a run", "inputSchema": {"type": "object"},
     "annotations": {"readOnlyHint": False, "destructiveHint": True}},
]


class Handler(http.server.BaseHTTPRequestHandler):
    token = "fake-token"
    calls = []

    def do_POST(self):
        if self.headers.get("authorization") != "Bearer " + Handler.token:
            return self.reply(401, {"error": "unauthorized"})
        message = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        method, rid = message.get("method"), message.get("id")
        if rid is None:
            self.send_response(202)
            self.end_headers()
            return None
        if method == "initialize":
            result = {"protocolVersion": message["params"].get("protocolVersion", "2025-06-18"),
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "janusly", "version": "fake"}}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            Handler.calls.append(message["params"]["name"])
            result = {"content": [{"type": "text", "text": json.dumps({"ok": True})}]}
        else:
            return self.reply(200, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "unknown method"}})
        return self.reply(200, {"jsonrpc": "2.0", "id": rid, "result": result})

    def do_GET(self):
        self.reply(405, {"error": "use POST"})

    def do_DELETE(self):
        self.reply(405, {"error": "stateless"})

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def serve(token="fake-token", port=0):
    Handler.token, Handler.calls = token, []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":
    serve(sys.argv[1], int(sys.argv[2]))
    threading.Event().wait()
