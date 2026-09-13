// The client side of the CLI: talks to a running daemon over HTTP. Functions
// return the text to print and throw CliError for anything the user has to
// see; main.ts turns that into an exit code.

import { resolve, basename } from "node:path";
import { statSync } from "node:fs";
import type { Options } from "./args";

export class CliError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
  }
}

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
    throw new CliError(
      `no daemon listening on ${baseUrl(options)} (${(err as Error).message})\n` +
        "Start it by running obs-video-trigger with no arguments.",
    );
  }
}

// The daemon always answers JSON. Anything else means some other program owns
// the port, and that deserves a plain message rather than a JSON parse trace.
async function readJson<T>(options: Options, response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError(
      `unexpected reply from ${baseUrl(options)} (HTTP ${response.status}) - is something else on this port?`,
    );
  }
}

type PlayReply = { ok: boolean; overlays: number; error?: string };

export async function commandPlay(options: Options): Promise<string> {
  const file = resolve(options.file);

  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw new CliError(`no such file: ${file}`, 2);
  }
  if (!stat.isFile()) throw new CliError(`not a file: ${file}`, 2);

  const response = await request(options, "/play", { file, volume: options.volume, fit: options.fit });
  const result = await readJson<PlayReply>(options, response);

  if (!response.ok || !result.ok) throw new CliError(result.error ?? response.statusText);
  if (result.overlays === 0) {
    throw new CliError("warning: no overlay connected - is the OBS browser source running?");
  }
  return `triggered ${basename(file)} on ${result.overlays} overlay(s)`;
}

export async function commandStop(options: Options): Promise<string> {
  const response = await request(options, "/stop");
  return JSON.stringify(await readJson(options, response));
}

export async function commandStatus(options: Options): Promise<string> {
  const response = await request(options, "/status");
  return JSON.stringify(await readJson(options, response));
}

type DevicesReply = {
  ok: boolean;
  overlays?: number;
  audioDevice?: string;
  devices?: Array<{ id: string; label: string }>;
  error?: string;
};

export async function commandAudioDevices(options: Options): Promise<string> {
  const response = await request(options, "/audio-devices");
  const result = await readJson<DevicesReply>(options, response);
  if (!response.ok || !result.ok) throw new CliError(result.error ?? response.statusText);

  const devices = result.devices ?? [];
  const lines = [`Audio output devices seen by the overlay (${result.overlays} connected):`];
  if (devices.length === 0) {
    lines.push("  no audio output devices reported - the overlay may still be enumerating, try again");
  } else {
    for (const device of devices) lines.push(`  ${device.label || "(unnamed)"}   [${device.id}]`);
  }
  if (result.audioDevice) lines.push(`Currently bound to: ${result.audioDevice}`);
  lines.push('Bind one with: obs-video-trigger --audio-device "<name>"');
  return lines.join("\n");
}
