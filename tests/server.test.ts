// Exercises the daemon over real HTTP on a random port.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon, displayBase, type Daemon } from "../src/server";

const dir = mkdtempSync(join(tmpdir(), "obs-video-trigger-"));
const CLIP = join(dir, "clip.webm");
const BYTES = new Uint8Array(1000).map((_, i) => i % 256);
writeFileSync(CLIP, BYTES);

let daemon: Daemon;
let base: string;
let shutdowns = 0;

beforeAll(() => {
  daemon = createDaemon({
    host: "127.0.0.1",
    port: 0,
    shutdownToken: "secret",
    log: () => {},
    onShutdown: () => {
      shutdowns += 1;
    },
  });
  base = daemon.base;
});

afterAll(() => {
  daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

type Event = Record<string, unknown>;

// Opens the SSE stream and returns a reader that yields parsed events.
async function openEvents() {
  const response = await fetch(`${base}/events`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: Event[] = [];
  return {
    async next(): Promise<Event> {
      while (queue.length === 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error("event stream closed");
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) queue.push(JSON.parse(data.slice(6)));
        }
      }
      return queue.shift()!;
    },
    close: () => reader.cancel(),
  };
}

const play = (params: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base}/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(params),
  });

test("displayBase swaps wildcard hosts for a loopback address", () => {
  expect(displayBase("127.0.0.1", 4466)).toBe("http://127.0.0.1:4466");
  expect(displayBase("0.0.0.0", 4466)).toBe("http://127.0.0.1:4466");
  expect(displayBase("::", 4466)).toBe("http://[::1]:4466");
  expect(displayBase("::1", 4466)).toBe("http://[::1]:4466");
  expect(displayBase("192.168.1.5", 80)).toBe("http://192.168.1.5:80");
});

test("the overlay page is served with its version stamped in", async () => {
  const html = await (await fetch(`${base}/overlay`)).text();
  expect(html).toContain("<video");
  expect(html).not.toContain("__OVERLAY_VERSION__");
});

test("unknown paths are 404", async () => {
  expect((await fetch(`${base}/nope`)).status).toBe(404);
});

test("play without a file is 400", async () => {
  const response = await play({});
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ ok: false, error: "missing file" });
});

test("play with a relative path is 400", async () => {
  const response = await play({ file: "clips/a.webm" });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("absolute path");
});

test("play with a missing file is 404", async () => {
  const response = await play({ file: join(dir, "missing.webm") });
  expect(response.status).toBe(404);
});

test("play with a directory is 404", async () => {
  const response = await play({ file: dir });
  expect(response.status).toBe(404);
});

test("play broadcasts the clip and reports the overlay count", async () => {
  const events = await openEvents();
  expect((await events.next()).type).toBe("hello");

  const response = await play({ file: CLIP, volume: 0.5, fit: "cover" });
  expect(await response.json()).toEqual({ ok: true, file: CLIP, overlays: 1 });

  const event = await events.next();
  expect(event).toMatchObject({ type: "play", name: "clip.webm", file: CLIP, volume: 0.5, fit: "cover" });
  expect(event.src).toMatch(/^\/media\/\d+$/);
  events.close();
});

test("play via GET query string works the same", async () => {
  const events = await openEvents();
  await events.next();
  const response = await fetch(`${base}/play?file=${encodeURIComponent(CLIP)}&volume=2&fit=cover`);
  expect((await response.json()).ok).toBe(true);
  const event = await events.next();
  expect(event.volume).toBe(1);
  events.close();
});

test("an unknown fit falls back to contain", async () => {
  const events = await openEvents();
  await events.next();
  await play({ file: CLIP, fit: "stretch" });
  expect((await events.next()).fit).toBe("contain");
  events.close();
});

test("re-triggering a file reuses its media id", async () => {
  const events = await openEvents();
  await events.next();
  await play({ file: CLIP });
  const first = await events.next();
  await play({ file: CLIP });
  const second = await events.next();
  expect(second.src).toBe(first.src);
  events.close();
});

test("stop broadcasts a stop event", async () => {
  const events = await openEvents();
  await events.next();
  const response = await fetch(`${base}/stop`);
  expect((await response.json()).ok).toBe(true);
  expect((await events.next()).type).toBe("stop");
  events.close();
});

test("status reports counts", async () => {
  const status = await (await fetch(`${base}/status`)).json();
  expect(status.ok).toBe(true);
  expect(status.clips).toBe(1);
  expect(typeof status.overlays).toBe("number");
  expect(status.port).toBe(daemon.server.port);
});

test("media serves a triggered file whole", async () => {
  const response = await fetch(`${base}/media/1`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("video/webm");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
});

test("media honours a byte range", async () => {
  const response = await fetch(`${base}/media/1`, { headers: { Range: "bytes=10-19" } });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 10-19/1000");
  expect(response.headers.get("content-length")).toBe("10");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(10, 20));
});

test("an unsatisfiable range is 416", async () => {
  const response = await fetch(`${base}/media/1`, { headers: { Range: "bytes=5000-" } });
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */1000");
});

test("media for an unknown id is 404", async () => {
  expect((await fetch(`${base}/media/999`)).status).toBe(404);
});

test("media for a file that disappeared after triggering is 404", async () => {
  const gone = join(dir, "gone.webm");
  writeFileSync(gone, BYTES);
  const events = await openEvents();
  await events.next();
  await play({ file: gone });
  const src = (await events.next()).src as string;
  events.close();
  rmSync(gone);
  expect((await fetch(base + src)).status).toBe(404);
});

test("shutdown with a bad token is 403 and does nothing", async () => {
  const response = await fetch(`${base}/shutdown?token=wrong`, { method: "POST" });
  expect(response.status).toBe(403);
  expect(shutdowns).toBe(0);
});

test("shutdown with the token calls back", async () => {
  const response = await fetch(`${base}/shutdown?token=secret`, { method: "POST" });
  expect((await response.json()).ok).toBe(true);
  expect(shutdowns).toBe(1);
});

// A web page in the user's browser can reach 127.0.0.1 too. Browser requests
// carry Sec-Fetch-Site; a Stream Deck, curl or the CLI never send it.
test("a cross-site browser request cannot trigger a clip", async () => {
  const response = await play({ file: CLIP }, { "Sec-Fetch-Site": "cross-site" });
  expect(response.status).toBe(403);
});

test("a cross-site browser request cannot stop a clip", async () => {
  const response = await fetch(`${base}/stop`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(response.status).toBe(403);
});

test("a request typed into the address bar still works", async () => {
  const response = await fetch(`${base}/stop`, { headers: { "Sec-Fetch-Site": "none" } });
  expect(response.status).toBe(200);
});

// DNS rebinding: an attacker's hostname resolving to 127.0.0.1 arrives with
// that hostname in Host. Only loopback names are accepted on a loopback bind.
test("a request with a foreign Host header is rejected", async () => {
  const response = await fetch(`${base}/status`, { headers: { Host: "evil.example:4466" } });
  expect(response.status).toBe(403);
  const media = await fetch(`${base}/media/1`, { headers: { Host: "evil.example" } });
  expect(media.status).toBe(403);
});

test("localhost is an accepted Host", async () => {
  const response = await fetch(`${base}/status`, { headers: { Host: `localhost:${daemon.server.port}` } });
  expect(response.status).toBe(200);
});
