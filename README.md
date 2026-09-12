# obs-video-trigger

A single Windows executable that plays a video clip **once** in an OBS browser source —
fullscreen, unmuted, no controls — and leaves the source transparent again when the clip
ends. Triggered by opening a URL or running the binary with a path, so it works from a
Stream Deck, a chat bot, a batch file, or anything else that can open a URL.

- One static `.exe`, no runtime, no installer, no config file.
- Runs as a background daemon with a tray icon.
- Any video file on disk; nothing has to be copied into a special folder.
- Same clip triggered again while playing → stops it. Different clip → replaces it.

## Documentation

| Document | For |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Streamers. Five steps: run it, add it to OBS, add a Stream Deck key, press. |
| [REFERENCE.md](REFERENCE.md) | Every option, from the command line and from a browser. Tray menu, OBS settings, playback rules, HTTP API, clip formats, troubleshooting. |

## Build

Requires [Bun](https://bun.sh) 1.1 or newer on the build machine only.

```
bun run build
```

Produces `dist/obs-video-trigger.exe` (~86 MB — it embeds the Bun runtime). The build
targets `bun-windows-x64` and uses `--windows-hide-console`, so neither the daemon nor a
trigger ever opens a console window; output still appears when run from an existing
terminal.

The binary is unsigned. Windows SmartScreen prompts once on first launch.

## Release

Push a tag and GitHub Actions builds the executable and attaches it to a release:

```
git tag v1.0.0
git push origin v1.0.0
```

The tag becomes the file version stamped into the exe (`v1.2.0` → `1.2.0.0`). See
`.github/workflows/release.yml`.

## Develop

```
bun run src/main.ts            # daemon from source, tray icon included
bun run src/main.ts --play x   # trigger from source
bun test                       # overlay behaviour tests
```

The daemon stamps the overlay page with a hash of its HTML and announces that version on
the event stream, so an overlay left open in OBS reloads itself after a rebuild.

## Layout

```
src/main.ts        CLI parsing, daemon (Bun.serve), HTTP routes, SSE broadcast
src/overlay.ts     The overlay page (HTML + inline script) as a string
src/tray.ts        Windows tray icon via a hidden PowerShell helper
tests/             Fake-DOM tests for the overlay script
dist/              Build output (ignored by git)
```

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
   it.
4. Only files that have been registered through `/play` are served from `/media`, so the
   page cannot be used to read arbitrary files.
5. The tray icon is a hidden `powershell.exe` running a Windows Forms `NotifyIcon`. "Stop
   daemon" calls `/shutdown` with a per-run token; if the daemon dies, the helper's status
   poll fails and it removes the icon.

## License

MIT
