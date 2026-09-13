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
import { commandPlay, commandStop, commandStatus, commandAudioDevices, CliError } from "./client";
import { createDaemon } from "./server";
import { startTray } from "./tray";

const HELP = `obs-video-trigger - play a video once in an OBS browser source

Usage:
  obs-video-trigger [daemon options]         Start the daemon (default).
  obs-video-trigger --play <file> [options]  Play a video file in the overlay.
  obs-video-trigger <file> [options]         Same as --play.
  obs-video-trigger --stop                   Hide the overlay immediately.
  obs-video-trigger --status                 Print daemon state as JSON.
  obs-video-trigger --list-audio-devices     List the audio output devices the
                                             overlay can play through.
  obs-video-trigger --help                   Show this help.

Daemon options (only with no command):
  --host <addr>            Address to listen on (default ${DEFAULT_HOST}).
                           0.0.0.0 accepts triggers from the network.
  --port <number>          Port to listen on (default ${DEFAULT_PORT}).
  --audio-device <name>    Play clip audio through this output device. <name>
                           is part of a device name from --list-audio-devices
                           (case-insensitive) or a device id. Not given: audio
                           stays with the OBS browser source. In OBS untick
                           "Control audio via OBS" on the source for this to
                           take effect.
  --no-tray                Do not show the Windows tray icon.

Play options (with --play or a bare file):
  --volume <0..1>          Playback volume for this clip (default 1).
  --fit <mode>             How the video fills the source: contain (letterbox),
                           cover (crop) or fill (stretch) (default contain).
  --interrupt              Accepted for compatibility; replacing is the default.

Connection options (any command):
  --host <addr>            Daemon address (default ${DEFAULT_HOST}).
  --port <number>          Daemon port (default ${DEFAULT_PORT}).

Other:
  -h, --help               Show this help.

Environment:
  OBS_VIDEO_TRIGGER_TOKEN  Pin the /shutdown token instead of a random one.

Exit codes: 0 delivered, 1 daemon or overlay missing, 2 bad argument or file.

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
      audioDevice: options.audioDevice,
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
  if (options.audioDevice) console.log(`  Audio output       : ${options.audioDevice}`);
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
    case "audio-devices":
      console.log(await commandAudioDevices(options));
      break;
    default:
      startDaemon(options);
  }
} catch (err) {
  if (!(err instanceof CliError)) throw err;
  console.error(err.message.startsWith("warning:") ? err.message : `error: ${err.message}`);
  process.exit(err.exitCode);
}
