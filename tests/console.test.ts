import { test, expect } from "bun:test";
import { needsParentConsole, createTerminal } from "../src/console";

// FILE_TYPE_DISK 1, FILE_TYPE_CHAR 2, FILE_TYPE_PIPE 3, FILE_TYPE_UNKNOWN 0

test("a dead console stub needs the parent console", () => {
  // What a GUI-subsystem exe started from a terminal sees.
  expect(needsParentConsole({ fileType: 2, isConsole: false })).toBe(true);
  expect(needsParentConsole({ fileType: 0, isConsole: false })).toBe(true);
});

test("a live console is left alone", () => {
  expect(needsParentConsole({ fileType: 2, isConsole: true })).toBe(false);
});

test("redirected output is left alone so it stays in the pipe or file", () => {
  expect(needsParentConsole({ fileType: 3, isConsole: false })).toBe(false);
  expect(needsParentConsole({ fileType: 1, isConsole: false })).toBe(false);
});

test("createTerminal always yields callable writers", () => {
  // Under bun test stdout is a pipe or a console, never a dead stub, so this
  // exercises the fallback path on every platform.
  const terminal = createTerminal();
  expect(typeof terminal.out).toBe("function");
  expect(typeof terminal.err).toBe("function");
});
