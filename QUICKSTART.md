# Quick start

Play a video clip over your stream with one Stream Deck key. It plays once, with sound,
then disappears.

## 1. Run it

First, stop Windows from asking every time: right-click `obs-video-trigger.exe` →
**Properties** → tick **Unblock** → **OK**. (If you already see "Windows protected your
PC", click **More info → Run anyway** instead.)

Double-click `obs-video-trigger.exe`.

Nothing opens. A blue play icon appears in the tray next to the clock. That means it is
running. Leave it running while you stream.

To stop it: right-click the icon → **Stop daemon**.

## 2. Add it to OBS

**Sources → + → Browser**, then:

| Setting | Value |
|---|---|
| URL | `http://127.0.0.1:4466/overlay` |
| Width / Height | `1920` / `1080` (same as your canvas) |
| Shutdown source when not visible | untick |
| Refresh browser when scene becomes active | untick |

Drag the new source to the **top** of the list. It is invisible until a clip plays.

## 3. Add a Stream Deck key

**System → Website**

| Field | Value |
|---|---|
| URL | `http://127.0.0.1:4466/play?file=C:\Clips\airhorn.mp4` |
| Access in background | tick |

Put your own clip's path after `file=`. One key per clip.

If the path has a space in it, write `%20` instead of the space:
`http://127.0.0.1:4466/play?file=C:\My%20Clips\airhorn.mp4`

## 4. Press the key

The clip plays over your scene and then vanishes.

- Press the **same key again** while it plays → it stops.
- Press a **different clip key** while it plays → the new clip takes over.

Handy extra key — clears the screen at any time:
`http://127.0.0.1:4466/stop`

## If it does not work

- **No tray icon?** Run `obs-video-trigger.exe` again.
- **Icon there, nothing plays?** Open `http://127.0.0.1:4466/status` in a browser. If it
  says `"overlays":0`, OBS is not showing the page: check the browser source is in your
  current scene and both boxes above are unticked, then right-click the source →
  **Refresh**.
- **No sound?** In OBS, tick **Control audio via OBS** on the browser source and check
  its channel in the mixer.

Full details: [REFERENCE.md](REFERENCE.md).
