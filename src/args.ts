// Command-line parsing. Pure: throws UsageError instead of exiting so it can be
// tested and so main.ts owns the process exit.

export const DEFAULT_HOST = "127.0.0.1";
// 4455 is obs-websocket's default port, so keep out of its way.
export const DEFAULT_PORT = 4466;

export const FIT_MODES = ["contain", "cover", "fill"] as const;
export type FitMode = (typeof FIT_MODES)[number];

export function isFitMode(value: unknown): value is FitMode {
  return typeof value === "string" && (FIT_MODES as readonly string[]).includes(value);
}

export class UsageError extends Error {}

export type Options = {
  command: "daemon" | "play" | "stop" | "status" | "audio-devices" | "help";
  file: string;
  host: string;
  port: number;
  volume: number;
  fit: FitMode;
  tray: boolean;
  // Daemon only: name (or browser device id) of the audio output device the
  // overlay should send clip audio to. Empty means leave the browser default.
  audioDevice: string;
};

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: "daemon",
    file: "",
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    volume: 1,
    fit: "contain",
    tray: true,
    audioDevice: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      return next;
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
      case "--list-audio-devices":
        options.command = "audio-devices";
        break;
      case "--audio-device":
        options.audioDevice = value();
        break;
      case "--daemon":
      case "--serve":
        options.command = "daemon";
        break;
      case "--host":
        options.host = value();
        break;
      case "--port": {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new UsageError("--port needs a whole number between 1 and 65535");
        }
        options.port = port;
        break;
      }
      case "--volume": {
        const volume = Number(value());
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
          throw new UsageError("--volume needs a number between 0 and 1");
        }
        options.volume = volume;
        break;
      }
      case "--fit": {
        const fit = value();
        if (!isFitMode(fit)) throw new UsageError("--fit must be contain, cover or fill");
        options.fit = fit;
        break;
      }
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
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
        options.command = "play";
        options.file = arg;
    }
  }

  return options;
}
