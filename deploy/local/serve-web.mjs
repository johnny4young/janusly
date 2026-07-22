/** Minimal dependency-free static server for the production web image. */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, normalize, resolve } from "node:path";

const root = resolve(process.env.STATIC_ROOT ?? "/app/dist");
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function safePath(pathname) {
  try {
    const decoded = decodeURIComponent(pathname);
    const candidate = resolve(root, `.${normalize(decoded)}`);
    return candidate === root || candidate.startsWith(`${root}/`) ? candidate : null;
  } catch {
    return null;
  }
}

async function existingFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  let path = safePath(url.pathname);
  if (!path) {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (!(await existingFile(path))) path = resolve(root, "index.html");

  res.writeHead(200, {
    "content-type": mime[extname(path)] ?? "application/octet-stream",
    "cache-control": path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  createReadStream(path).pipe(res);
});

server.listen(port, host, () => console.log(`[web] listening on http://${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
