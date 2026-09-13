// The CLI side (--play, --stop, --status) against a real daemon and against a
// server that is not the daemon at all.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon, type Daemon } from "../src/server";
import { commandPlay, commandStop, commandStatus, commandAudioDevices, CliError } from "../src/client";
import { parseArgs } from "../src/args";

const dir = mkdtempSync(join(tmpdir(), "obs-video-trigger-cli-"));
const CLIP = join(dir, "clip.webm");
writeFileSync(CLIP, new Uint8Array(10));

let daemon: Daemon;
let stranger: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  daemon = createDaemon({ host: "127.0.0.1", port: 0, log: () => {} });
  stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Not found", { status: 404 }) });
});

afterAll(() => {
  daemon.stop();
  stranger.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const withPort = (port: number, ...argv: string[]) => parseArgs(["--port", String(port), ...argv]);

test("play with no overlay connected fails with a warning", async () => {
  const options = withPort(daemon.server.port!, "--play", CLIP);
  await expect(commandPlay(options)).rejects.toThrow("no overlay connected");
});

test("play reports the triggered clip once an overlay listens", async () => {
  const events = await fetch(`${daemon.base}/events`);
  const options = withPort(daemon.server.port!, "--play", CLIP);
  expect(await commandPlay(options)).toBe("triggered clip.webm on 1 overlay(s)");
  await events.body!.cancel();
});

test("play with a missing file fails before contacting the daemon", async () => {
  const options = withPort(1, "--play", join(dir, "nope.webm"));
  await expect(commandPlay(options)).rejects.toThrow("no such file");
});

test("stop and status return the daemon's reply", async () => {
  const options = withPort(daemon.server.port!);
  expect(await commandStop(options)).toContain('"ok":true');
  expect(await commandStatus(options)).toContain('"clips":1');
});

test("no daemon on the port is a clear error, not a stack trace", async () => {
  const options = withPort(1, "--stop");
  const error = await commandStop(options).catch((e) => e);
  expect(error).toBeInstanceOf(CliError);
  expect(error.message).toContain("no daemon listening on http://127.0.0.1:1");
});

test("a non-JSON reply from something else on the port is a clear error", async () => {
  const options = withPort(stranger.port!, "--play", CLIP);
  const error = await commandPlay(options).catch((e) => e);
  expect(error).toBeInstanceOf(CliError);
  expect(error.message).toContain("unexpected reply");
});

test("listing audio devices needs an overlay", async () => {
  const options = withPort(daemon.server.port!, "--list-audio-devices");
  await expect(commandAudioDevices(options)).rejects.toThrow("no overlay connected");
});

test("listing audio devices prints one device per line", async () => {
  const events = await fetch(`${daemon.base}/events`);
  await fetch(`${daemon.base}/audio-devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ devices: [{ id: "spk", label: "Speakers (Realtek)" }, { id: "hs", label: "Headset" }] }),
  });
  const options = withPort(daemon.server.port!, "--list-audio-devices");
  expect(await commandAudioDevices(options)).toBe(
    "Audio output devices seen by the overlay (1 connected):\n" +
      "  Speakers (Realtek)   [spk]\n" +
      "  Headset   [hs]\n" +
      "Bind one with: obs-video-trigger --audio-device \"<name>\"",
  );
  await events.body!.cancel();
});

test("an empty device list says so", async () => {
  const events = await fetch(`${daemon.base}/events`);
  await fetch(`${daemon.base}/audio-devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ devices: [] }),
  });
  const options = withPort(daemon.server.port!, "--list-audio-devices");
  expect(await commandAudioDevices(options)).toContain("no audio output devices reported");
  await events.body!.cancel();
});
