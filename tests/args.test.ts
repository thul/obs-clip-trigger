import { test, expect } from "bun:test";
import { parseArgs, UsageError, DEFAULT_HOST, DEFAULT_PORT } from "../src/args";

test("no arguments starts the daemon with defaults", () => {
  const options = parseArgs([]);
  expect(options.command).toBe("daemon");
  expect(options.host).toBe(DEFAULT_HOST);
  expect(options.port).toBe(DEFAULT_PORT);
  expect(options.volume).toBe(1);
  expect(options.fit).toBe("contain");
  expect(options.tray).toBe(true);
});

test("--play takes the file", () => {
  const options = parseArgs(["--play", "C:\clips\a.webm"]);
  expect(options.command).toBe("play");
  expect(options.file).toBe("C:\clips\a.webm");
});

test("a bare path means --play", () => {
  const options = parseArgs(["C:\clips\a.webm", "--volume", "0.5"]);
  expect(options.command).toBe("play");
  expect(options.file).toBe("C:\clips\a.webm");
  expect(options.volume).toBe(0.5);
});

test("--stop, --status and --help set the command", () => {
  expect(parseArgs(["--stop"]).command).toBe("stop");
  expect(parseArgs(["--status"]).command).toBe("status");
  expect(parseArgs(["-h"]).command).toBe("help");
});

test("--no-tray turns the tray off", () => {
  expect(parseArgs(["--no-tray"]).tray).toBe(false);
});

test("--interrupt is accepted and ignored", () => {
  expect(parseArgs(["--interrupt", "x.mp4"]).command).toBe("play");
});

test("an option without its value is a usage error", () => {
  expect(() => parseArgs(["--play"])).toThrow(UsageError);
  expect(() => parseArgs(["--play"])).toThrow("--play needs a value");
});

test("an unknown option is a usage error", () => {
  expect(() => parseArgs(["--bogus"])).toThrow("unknown option: --bogus");
});

test("--port must be a whole number between 1 and 65535", () => {
  expect(parseArgs(["--port", "5000"]).port).toBe(5000);
  expect(() => parseArgs(["--port", "abc"])).toThrow(UsageError);
  expect(() => parseArgs(["--port", "0"])).toThrow(UsageError);
  expect(() => parseArgs(["--port", "65536"])).toThrow(UsageError);
  expect(() => parseArgs(["--port", "12.5"])).toThrow(UsageError);
});

test("--volume must be between 0 and 1", () => {
  expect(parseArgs(["--volume", "0"]).volume).toBe(0);
  expect(() => parseArgs(["--volume", "1.5"])).toThrow(UsageError);
  expect(() => parseArgs(["--volume", "x"])).toThrow(UsageError);
});

test("--fit accepts contain, cover and fill only", () => {
  expect(parseArgs(["--fit", "cover"]).fit).toBe("cover");
  expect(() => parseArgs(["--fit", "stretch"])).toThrow("--fit must be contain, cover or fill");
});
