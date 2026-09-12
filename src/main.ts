// obs-video-trigger
//
// One binary, two roles:
//   obs-video-trigger                     start the daemon (default)
//   obs-video-trigger --play <file>       tell the running daemon to play a clip
//
// The daemon serves an overlay page for an OBS browser source. The page is
// transparent until a clip is triggered, plays it once fullscreen and unmuted
// with no controls, then goes transparent again.
//
// This file is the process boundary only: argument parsing, exit codes, tray
// and signals. The HTTP daemon lives in server.ts, the client in client.ts.

import { parseArgs, UsageError, DEFAULT_HOST, DEFAULT_PORT, type Options } from "./args";
import { commandPlay, commandStop, commandStatus, CliError } from "./client";
import { createDaemon } from "./server";
import { startTray } from "./tray";

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

function startDaemon(options: Options) {
  let tray: ReturnType<typeof startTray> = null;

  function shutdown(code: number): never {
    tray?.stop();
    process.exit(code);
  }

  let daemon;
  try {
    daemon = createDaemon({
      host: options.host,
      port: options.port,
      // OBS_VIDEO_TRIGGER_TOKEN pins the shutdown token, which is handy for
      // scripting a shutdown. Note that the token also appears in the tray
      // helper's command line, so it is a guard against web pages, not against
      // other programs running as the same user.
      shutdownToken: process.env.OBS_VIDEO_TRIGGER_TOKEN,
      onShutdown: () => setTimeout(() => shutdown(0), 50),
    });
  } catch (err) {
    const error = err as { code?: string };
    if (error.code === "EADDRINUSE") {
      console.error(`error: port ${options.port} is already in use - the daemon may already be running.`);
      process.exit(1);
    }
    throw err;
  }

  if (options.tray) {
    tray = startTray(daemon.base, daemon.shutdownToken);
    // Take the icon down however the daemon ends: Ctrl+C, a console close, or a
    // crash.
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    process.on("exit", () => tray?.stop());
  }

  console.log("obs-video-trigger daemon running.");
  console.log(`  OBS browser source : ${daemon.base}/overlay`);
  console.log(`  Trigger a clip     : obs-video-trigger --play "C:\\path\\to\\clip.webm"`);
  console.log(
    tray
      ? "  Stop with Ctrl+C, or right-click the tray icon and choose Stop daemon."
      : "  Stop with Ctrl+C.",
  );
}

// ---------------------------------------------------------------------------

let options: Options;
try {
  options = parseArgs(Bun.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(2);
}

try {
  switch (options.command) {
    case "help":
      console.log(HELP);
      break;
    case "play":
      console.log(await commandPlay(options));
      break;
    case "stop":
      console.log(await commandStop(options));
      break;
    case "status":
      console.log(await commandStatus(options));
      break;
    default:
      startDaemon(options);
  }
} catch (err) {
  if (!(err instanceof CliError)) throw err;
  console.error(err.message.startsWith("warning:") ? err.message : `error: ${err.message}`);
  process.exit(err.exitCode);
}
