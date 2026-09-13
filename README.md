# obs-video-trigger

A single Windows executable that plays a video clip **once** in an OBS browser source —
fullscreen, unmuted, no controls — and leaves the source transparent again when the clip
ends. Triggered by opening a URL or running the binary with a path, so it works from a
Stream Deck, a chat bot, a batch file, or anything else that can open and reach the URL.

- One static `.exe`, no runtime, no installer, no config file.
- Runs as a background daemon with a tray icon.
- Any video file on disk; nothing has to be copied into a special folder.
- Same clip triggered again while playing → stops it. Different clip → replaces it.
- Audio goes through the OBS browser source by default, or to a Windows output device of
  your choice with `--audio-device`.

## Documentation

| Document | For |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Streamers. Five steps: run it, add it to OBS, add a Stream Deck key, press. |
| [REFERENCE.md](REFERENCE.md) | Every option, from the command line and from a browser. Tray menu, OBS settings, playback rules, HTTP API, clip formats, troubleshooting. |

## Build

Requires [Bun](https://bun.sh) 1.4 or newer on the build machine only.

```
bun install
bun run build
```

Produces `dist/obs-video-trigger.exe` (~86 MB — it embeds the Bun runtime). The build
targets `bun-windows-x64` and uses `--windows-hide-console`, so neither the daemon nor a
trigger ever opens a console window. Run from an existing terminal, the exe attaches to
that terminal (`src/console.ts`) so `--help`, the daemon log and error messages still
show; because it is a GUI-subsystem program the shell does not wait for it, so the output
lands after the prompt and `%ERRORLEVEL%` is not set — use `start /wait` when a script
needs the exit code. The file version stamped into the exe is taken from `package.json`; the release
workflow refuses a tag that does not match it. Releases ship a `SHA256SUMS.txt` next to
the exe, so a download can be checked with `certutil -hashfile obs-video-trigger.exe SHA256`.

The binary is unsigned, so Windows shows "Windows protected your PC" the first time a
downloaded copy runs. Two ways past it:

- **One time:** click **More info → Run anyway**.
- **Permanently, before the first run:** right-click `obs-video-trigger.exe` →
  **Properties** → tick **Unblock** at the bottom of the General tab → **OK**. This
  removes the "downloaded from the internet" mark, and SmartScreen no longer asks.
  Equivalent in PowerShell: `Unblock-File .obs-video-trigger.exe`.

## Develop

```
bun run src/main.ts            # daemon from source, tray icon included
bun run src/main.ts --play x   # trigger from source
bun test                       # overlay, daemon, CLI and parser tests
bun run typecheck              # tsc --noEmit
bun run check                  # both
```

Layout: `src/main.ts` is the process boundary (arguments, exit codes, tray, signals);
`src/server.ts` is the HTTP daemon, `src/client.ts` the `--play`/`--stop`/`--status`
side, `src/args.ts` and `src/range.ts` the pure parsers, `src/overlay.ts` the browser page,
`src/tray.ts` the PowerShell tray helper and `src/console.ts` the terminal output of a
console-less exe. Tests start the daemon on a random port and
talk to it over real HTTP.

The daemon stamps the overlay page with a hash of its HTML and announces that version on
the event stream, so an overlay left open in OBS reloads itself after a rebuild.

## How it works

```
Stream Deck ──GET /play?file=…──▶ daemon (127.0.0.1:4466) ──SSE──▶ overlay page in OBS
                                       ▲                              │
                                       └────── GET /media/<id> ◀──────┘ (range requests)
```

1. The daemon listens on `127.0.0.1:4466`. Port 4455 is avoided because obs-websocket
   uses it.
2. `/play` checks the file exists, registers it under an id, and broadcasts a `play` event
   to every connected overlay over server-sent events.
3. The overlay page sets `<video src="/media/<id>">`, plays it unmuted, and hides itself
   on `ended`. A second `play` for the same file toggles it off; any other file replaces
   it. With `--audio-device` the page routes its audio to that device with `setSinkId()`;
   it reports the devices it can see to the daemon so `--list-audio-devices` can show
   them.
4. Only files that have been registered through `/play` are served from `/media`, so the
   page cannot be used to read arbitrary files. Browser requests from other sites are
   refused on `/play` and `/stop`, and a non-loopback `Host` header is refused everywhere
   while bound to loopback, so a web page cannot fire clips or read files through a
   DNS-rebinding trick.
5. The tray icon is a hidden `powershell.exe` running a Windows Forms `NotifyIcon`. "Stop
   daemon" calls `/shutdown` with a per-run token. The daemon holds the helper's stdin;
   when the daemon exits for any reason the pipe closes and the helper disposes the icon
   cleanly. A failed `/status` poll is the fallback.

## License

MIT
