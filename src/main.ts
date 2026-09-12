// obs-video-trigger
//
// One binary, two roles:
//   obs-video-trigger                     start the daemon (default)
//   obs-video-trigger --play <file>       tell the running daemon to play a clip
//
// The daemon serves an overlay page for an OBS browser source. The page is
// transparent until a clip is triggered, plays it once fullscreen and unmuted
// with no controls, then goes transparent again.

import { resolve, extname, basename } from "node:path";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { OVERLAY_HTML } from "./overlay";
import { startTray } from "./tray";

const DEFAULT_HOST = "127.0.0.1";
// 4455 is obs-websocket's default port, so keep out of its way.
const DEFAULT_PORT = 4466;

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
};

type Options = {
  command: "daemon" | "play" | "stop" | "status" | "help";
  file: string;
  host: string;
  port: number;
  volume: number;
  fit: string;
  tray: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: "daemon",
    file: "",
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    volume: 1,
    fit: "contain",
    tray: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) fail(`${arg} needs a value`);
      return next!;
    };

    switch (arg) {
      case "--play":
      case "-p":
        options.command = "play";
        options.file = value();
        break;
      case "--stop":
        options.command = "stop";
        break;
      case "--status":
        options.command = "status";
        break;
      case "--daemon":
      case "--serve":
        options.command = "daemon";
        break;
      case "--host":
        options.host = value();
        break;
      case "--port":
        options.port = Number(value());
        if (!Number.isInteger(options.port)) fail("--port needs a whole number");
        break;
      case "--volume":
        options.volume = Number(value());
        if (!Number.isFinite(options.volume) || options.volume < 0 || options.volume > 1) {
          fail("--volume needs a number between 0 and 1");
        }
        break;
      case "--fit":
        options.fit = value();
        break;
      case "--interrupt":
        // Replacing is now the default. Accepted so existing Stream Deck keys
        // keep working.
        break;
      case "--no-tray":
        options.tray = false;
        break;
      case "--help":
      case "-h":
        options.command = "help";
        break;
      default:
        // A bare path is treated as --play, so a Stream Deck action can pass the
        // file on its own.
        if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
        options.command = "play";
        options.file = arg;
    }
  }

  return options;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

const HELP = `obs-video-trigger - play a video once in an OBS browser source

Usage:
  obs-video-trigger                        Start the daemon (default).
  obs-video-trigger --play <file>          Play a video file in the overlay.
  obs-video-trigger <file>                 Same as --play.
  obs-video-trigger --stop                 Hide the overlay immediately.
  obs-video-trigger --status               Print daemon state as JSON.

Options:
  --host <addr>     Address the daemon listens on (default ${DEFAULT_HOST}).
  --port <number>   Port (default ${DEFAULT_PORT}).
  --volume <0..1>   Playback volume for this clip (default 1).
  --fit <mode>      CSS object-fit: contain, cover or fill (default contain).
  --no-tray         Do not show the Windows tray icon (daemon only).
  -h, --help        Show this help.

OBS browser source URL:  http://${DEFAULT_HOST}:${DEFAULT_PORT}/overlay
`;

// ---------------------------------------------------------------------------
// Client commands
// ---------------------------------------------------------------------------

function baseUrl(options: Options) {
  return `http://${options.host}:${options.port}`;
}

async function request(options: Options, path: string, body?: unknown) {
  try {
    return await fetch(baseUrl(options) + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    console.error(`error: no daemon listening on ${baseUrl(options)}`);
    console.error("Start it by running obs-video-trigger with no arguments.");
    process.exit(1);
  }
}

async function commandPlay(options: Options) {
  const file = resolve(options.file);

  let stat;
  try {
    stat = statSync(file);
  } catch {
    fail(`no such file: ${file}`);
  }
  if (!stat.isFile()) fail(`not a file: ${file}`);

  const response = await request(options, "/play", {
    file,
    volume: options.volume,
    fit: options.fit,
  });
  const result = (await response.json()) as { ok: boolean; overlays: number; error?: string };

  if (!response.ok || !result.ok) {
    console.error(`error: ${result.error ?? response.statusText}`);
    process.exit(1);
  }
  if (result.overlays === 0) {
    console.error("warning: no overlay connected - is the OBS browser source running?");
    process.exit(1);
  }
  console.log(`triggered ${basename(file)} on ${result.overlays} overlay(s)`);
}

async function commandStop(options: Options) {
  const response = await request(options, "/stop");
  console.log(await response.text());
}

async function commandStatus(options: Options) {
  const response = await request(options, "/status");
  console.log(await response.text());
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

type PlayEvent = {
  type: "play";
  id: string;
  name: string;
  // Absolute path, used by the overlay to recognise a repeated trigger of the
  // clip it is already showing and toggle it off.
  file: string;
  src: string;
  volume: number;
  fit: string;
};

// Identifies this build of the overlay page. An already-open page compares it
// against its own stamp and reloads when they differ, so a rebuilt daemon does
// not leave OBS running the previous page.
const OVERLAY_VERSION = Bun.hash(OVERLAY_HTML).toString(36);
const STAMPED_OVERLAY_HTML = OVERLAY_HTML.replaceAll("__OVERLAY_VERSION__", OVERLAY_VERSION);

function startDaemon(options: Options) {
  const encoder = new TextEncoder();
  // Random per run, so only the tray helper the daemon started can stop it.
  // OBS_VIDEO_TRIGGER_TOKEN pins it, which is handy for scripting a shutdown.
  const shutdownToken = process.env.OBS_VIDEO_TRIGGER_TOKEN || randomUUID();
  let tray: ReturnType<typeof startTray> = null;

  function shutdown(code: number): never {
    tray?.stop();
    process.exit(code);
  }

  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  // Only files that were explicitly triggered can be fetched over HTTP, so the
  // overlay endpoint cannot be used to read arbitrary files from disk.
  const allowed = new Map<string, string>();
  const ids = new Map<string, string>();
  let served = 0;

  function broadcast(event: unknown) {
    const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const client of clients) {
      try {
        client.enqueue(payload);
      } catch {
        clients.delete(client);
      }
    }
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
        console.log(`overlay connected (${clients.size} total)`);
      },
      cancel() {
        clients.delete(self);
        console.log(`overlay disconnected (${clients.size} total)`);
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
  setInterval(() => {
    const ping = encoder.encode(": ping\n\n");
    for (const client of clients) {
      try {
        client.enqueue(ping);
      } catch {
        clients.delete(client);
      }
    }
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
      fit: String(params.fit ?? "contain"),
    };

    const overlays = broadcast(event);
    console.log(`trigger ${event.name} -> ${overlays} overlay(s)`);
    return json({ ok: true, file, overlays });
  }

  // Streams a triggered file, honouring Range requests so the browser source can
  // buffer and seek.
  function serveMedia(req: Request, id: string) {
    const path = allowed.get(id);
    if (!path) return new Response("Unknown clip", { status: 404 });

    const file = Bun.file(path);
    const size = file.size;
    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.get("range");

    if (!range) {
      return new Response(file, {
        headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes", "Cache-Control": "no-store" },
      });
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });

    let start = match[1] === "" ? NaN : Number(match[1]);
    let end = match[2] === "" ? NaN : Number(match[2]);

    if (Number.isNaN(start)) {
      // Suffix range: the last N bytes of the file.
      start = Math.max(0, size - (Number.isNaN(end) ? 0 : end));
      end = size - 1;
    } else if (Number.isNaN(end) || end >= size) {
      end = size - 1;
    }

    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }

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

  let server;
  try {
    server = Bun.serve({
      hostname: options.host,
      port: options.port,
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (path === "/events") return eventStream();
        if (path === "/play") return handlePlay(req, url);

        if (path === "/stop") {
          const overlays = broadcast({ type: "stop" });
          return json({ ok: true, overlays });
        }

        if (path === "/status") {
          return json({ ok: true, overlays: clients.size, clips: served, port: options.port });
        }

        // Used by the tray icon's "Stop daemon" item. The token is generated at
        // startup and handed to the tray helper, so a random page in a browser
        // cannot shut the daemon down.
        if (path === "/shutdown") {
          if (url.searchParams.get("token") !== shutdownToken) {
            return json({ ok: false, error: "bad token" }, 403);
          }
          console.log("shutdown requested from the tray icon");
          setTimeout(() => shutdown(0), 50);
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
  } catch (err) {
    const error = err as { code?: string };
    if (error.code === "EADDRINUSE") {
      console.error(`error: port ${options.port} is already in use - the daemon may already be running.`);
      process.exit(1);
    }
    throw err;
  }

  const base = `http://${options.host}:${server.port}`;

  if (options.tray) {
    tray = startTray(base, shutdownToken);
    // Take the icon down however the daemon ends: Ctrl+C, a console close, or a
    // crash.
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    process.on("exit", () => tray?.stop());
  }

  console.log("obs-video-trigger daemon running.");
  console.log(`  OBS browser source : ${base}/overlay`);
  console.log(`  Trigger a clip     : obs-video-trigger --play "C:\\path\\to\\clip.webm"`);
  console.log(
    tray
      ? "  Stop with Ctrl+C, or right-click the tray icon and choose Stop daemon."
      : "  Stop with Ctrl+C.",
  );
}

// ---------------------------------------------------------------------------

const options = parseArgs(Bun.argv.slice(2));

switch (options.command) {
  case "help":
    console.log(HELP);
    break;
  case "play":
    await commandPlay(options);
    break;
  case "stop":
    await commandStop(options);
    break;
  case "status":
    await commandStatus(options);
    break;
  default:
    startDaemon(options);
}
