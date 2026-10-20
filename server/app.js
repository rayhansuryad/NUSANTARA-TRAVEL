import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon"
};

/* The same four handlers Vercel runs, mounted by path. */
const ROUTES = {
  "/api/bookings": () => import("../api/bookings/index.js"),
  "/api/bookings/status": () => import("../api/bookings/status.js"),
  "/api/webhooks/midtrans": () => import("../api/webhooks/midtrans.js"),
  "/api/cron/reconcile": () => import("../api/cron/reconcile.js")
};

function isInsideRoot(file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/*
 * Static files plus the API routes, with no listener attached, so tests can
 * drive the real handlers on an ephemeral port.
 */
export function createApp() {
  return createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const loader = ROUTES[pathname];

    if (loader) {
      try {
        const module = await loader();
        return await module.default(req, res);
      } catch (error) {
        console.error(`Handler for ${pathname} threw:`, error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "server", message: error.message }));
        }
        return;
      }
    }

    if (pathname.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not_found", path: pathname }));
    }

    /* Dotfiles are refused so a stray .env can never be downloaded by asking
       for it. */
    const segments = pathname.split("/").filter(Boolean);
    if (segments.some((segment) => segment.startsWith("."))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }

    const file = path.resolve(root, decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html");
    if (!isInsideRoot(file)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }

    try {
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });
}

export function listen(server, port) {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}
