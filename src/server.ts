// The daemon's HTTP server: overlay page, event stream, trigger endpoints and
// media streaming. No process-level concerns here (tray, signals, exit) so it
// can be started on a random port in tests.

import { resolve, extname, basename, isAbsolute } from "node:path";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { OVERLAY_HTML } from "./overlay";
import { isFitMode, type FitMode } from "./args";
import { parseRange } from "./range";

// Formats the OBS Chromium build can decode. AVI is left out on purpose: the
// container is almost always DivX/Xvid, which the browser source cannot play.
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
};

type PlayEvent = {
  type: "play";
  id: string;
  name: string;
  // Absolute path, used by the overlay to recognise a repeated trigger of the
  // clip it is already showing and toggle it off.
  file: string;
  src: string;
  volume: number;
  fit: FitMode;
};

// Identifies this build of the overlay page. An already-open page compares it
// against its own stamp and reloads when they differ, so a rebuilt daemon does
// not leave OBS running the previous page.
export const OVERLAY_VERSION = Bun.hash(OVERLAY_HTML).toString(36);
const STAMPED_OVERLAY_HTML = OVERLAY_HTML.replaceAll("__OVERLAY_VERSION__", OVERLAY_VERSION);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopback(host: string) {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function bracket(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

// The URL to show people. A wildcard bind address is not something a browser
// can open, so it is swapped for the matching loopback address.
export function displayBase(host: string, port: number) {
  if (host === "0.0.0.0") return `http://127.0.0.1:${port}`;
  if (host === "::" || host === "[::]") return `http://[::1]:${port}`;
  return `http://${bracket(host)}:${port}`;
}

export type DaemonOptions = {
  host: string;
  port: number;
  // Random per run unless pinned, so only the tray helper the daemon started
  // (or a script that knows the value) can stop it.
  shutdownToken?: string;
  log?: (message: string) => void;
  // Called after /shutdown was accepted; the caller decides how to exit.
  onShutdown?: () => void;
};

export type Daemon = {
  server: ReturnType<typeof Bun.serve>;
  base: string;
  shutdownToken: string;
  stop: () => void;
};

export function createDaemon(options: DaemonOptions): Daemon {
  const log = options.log ?? console.log;
  const shutdownToken = options.shutdownToken || randomUUID();
  const encoder = new TextEncoder();

  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  // Only files that were explicitly triggered can be fetched over HTTP, so the
  // media endpoint cannot be used to read arbitrary files from disk.
  const allowed = new Map<string, string>();
  const ids = new Map<string, string>();
  let served = 0;

  function send(client: ReadableStreamDefaultController<Uint8Array>, payload: Uint8Array) {
    try {
      client.enqueue(payload);
    } catch {
      clients.delete(client);
    }
  }

  function broadcast(event: unknown) {
    const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const client of clients) send(client, payload);
    return clients.size;
  }

  function eventStream() {
    let self: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        clients.add(controller);
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "hello", version: OVERLAY_VERSION })}\n\n`),
        );
        log(`overlay connected (${clients.size} total)`);
      },
      cancel() {
        clients.delete(self);
        log(`overlay disconnected (${clients.size} total)`);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  }

  // Keeps proxies and idle connections from dropping the event stream.
  const pinger = setInterval(() => {
    const ping = encoder.encode(": ping\n\n");
    for (const client of clients) send(client, ping);
  }, 15000);

  function json(body: unknown, status = 200) {
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  }

  async function handlePlay(req: Request, url: URL) {
    const params: Record<string, unknown> =
      req.method === "POST"
        ? await req.json().catch(() => ({}))
        : Object.fromEntries(url.searchParams);

    const rawFile = String(params.file ?? params.clip ?? "");
    if (!rawFile) return json({ ok: false, error: "missing file" }, 400);
    // A relative path would resolve against the daemon's working directory,
    // which is not what a Stream Deck URL author expects. The CLI resolves
    // before sending, so it is never affected.
    if (!isAbsolute(rawFile)) {
      return json({ ok: false, error: `absolute path required: ${rawFile}` }, 400);
    }

    const file = resolve(rawFile);
    try {
      if (!statSync(file).isFile()) return json({ ok: false, error: `not a file: ${file}` }, 404);
    } catch {
      return json({ ok: false, error: `no such file: ${file}` }, 404);
    }

    // One id per path, so re-triggering a clip reuses its URL instead of growing
    // the allow-list on every button press.
    let id = ids.get(file);
    if (!id) {
      id = String(++served);
      ids.set(file, id);
      allowed.set(id, file);
    }

    const volume = Number(params.volume ?? 1);
    const event: PlayEvent = {
      type: "play",
      id,
      name: basename(file),
      file,
      src: `/media/${id}`,
      volume: Number.isFinite(volume) ? Math.min(Math.max(volume, 0), 1) : 1,
      fit: isFitMode(params.fit) ? params.fit : "contain",
    };

    const overlays = broadcast(event);
    log(`trigger ${event.name} -> ${overlays} overlay(s)`);
    return json({ ok: true, file, overlays });
  }

  // Streams a triggered file, honouring Range requests so the browser source can
  // buffer and seek.
  async function serveMedia(req: Request, id: string) {
    const path = allowed.get(id);
    if (!path) return new Response("Unknown clip", { status: 404 });

    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Clip no longer exists", { status: 404 });
    const size = file.size;
    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.get("range");

    if (!range) {
      return new Response(file, {
        headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes", "Cache-Control": "no-store" },
      });
    }

    const span = parseRange(range, size);
    if (!span) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });

    const { start, end } = span;
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }

  // Requests from a browser tab carry Sec-Fetch-Site. A page on another site
  // must not be able to fire or stop clips on the stream; direct navigation
  // ("none") and the overlay's own origin are fine. Stream Deck, curl and the
  // CLI send no such header at all.
  function isForeignPage(req: Request) {
    const site = req.headers.get("sec-fetch-site");
    return site !== null && site !== "none" && site !== "same-origin";
  }

  // On a loopback bind only loopback names are valid in Host. Anything else
  // means a DNS-rebinding page has been pointed at this port. On a network
  // bind the operator chose to be reachable by name or LAN address, so the
  // check is skipped.
  const enforceHost = isLoopback(options.host);
  function isForeignHost(url: URL) {
    return enforceHost && !isLoopback(url.hostname);
  }

  // Filled in once the server is listening; port 0 means "pick one".
  let boundPort = options.port;

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (isForeignHost(url)) return new Response("Forbidden", { status: 403 });

      if (path === "/events") return eventStream();

      if (path === "/play" || path === "/stop") {
        if (isForeignPage(req)) return json({ ok: false, error: "cross-site request refused" }, 403);
        if (path === "/play") return handlePlay(req, url);
        const overlays = broadcast({ type: "stop" });
        return json({ ok: true, overlays });
      }

      if (path === "/status") {
        return json({ ok: true, overlays: clients.size, clips: served, port: boundPort });
      }

      // Used by the tray icon's "Stop daemon" item. The token is generated at
      // startup and handed to the tray helper, so a random page in a browser
      // cannot shut the daemon down.
      if (path === "/shutdown") {
        if (url.searchParams.get("token") !== shutdownToken) {
          return json({ ok: false, error: "bad token" }, 403);
        }
        log("shutdown requested");
        options.onShutdown?.();
        return json({ ok: true });
      }

      if (path.startsWith("/media/")) return serveMedia(req, path.slice("/media/".length));

      if (path === "/" || path === "/overlay" || path === "/overlay.html") {
        return new Response(STAMPED_OVERLAY_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  boundPort = server.port!;

  return {
    server,
    base: displayBase(options.host, boundPort),
    shutdownToken,
    stop() {
      clearInterval(pinger);
      server.stop(true);
    },
  };
}
