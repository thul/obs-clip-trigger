// Terminal output for a GUI-subsystem Windows build.
//
// The exe is compiled with --windows-hide-console so the daemon and Stream
// Deck triggers never flash a console window. The price is that a process
// started from an existing terminal is not attached to it: its stdout handle
// is a dead stub and console.log goes nowhere, so --help and every error
// message vanished. AttachConsole(ATTACH_PARENT_PROCESS) joins the parent's
// console, but Bun keeps writing to the handle it opened at startup, so text
// has to go through WriteConsoleW on the fresh handle instead.
//
// When stdout is a pipe or a file (redirected, or spawned by a script) the
// handle was inherited and works as it is; attaching would only risk moving
// output away from the pipe, so it is left alone.

export type HandleState = {
  // FILE_TYPE_UNKNOWN 0, FILE_TYPE_DISK 1, FILE_TYPE_CHAR 2, FILE_TYPE_PIPE 3
  fileType: number;
  // GetConsoleMode succeeded: the handle is a live console.
  isConsole: boolean;
};

export type Writer = (text: string) => void;

// A handle needs the parent console when it is neither redirected (disk or
// pipe) nor already a working console.
export function needsParentConsole(state: HandleState): boolean {
  return state.fileType !== 1 && state.fileType !== 3 && !state.isConsole;
}

const STD_OUTPUT_HANDLE = 0xfffffff5; // (DWORD)-11
const STD_ERROR_HANDLE = 0xfffffff4; // (DWORD)-12
const ATTACH_PARENT_PROCESS = 0xffffffff;

type Kernel32 = {
  AttachConsole: (pid: number) => number;
  GetStdHandle: (which: number) => number | bigint | null;
  GetFileType: (handle: unknown) => number;
  GetConsoleMode: (handle: unknown, mode: unknown) => number;
  WriteConsoleW: (handle: unknown, buffer: unknown, chars: number, written: unknown, reserved: null) => number;
};

function loadKernel32(): Kernel32 | null {
  if (process.platform !== "win32") return null;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("kernel32.dll", {
      AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
      GetStdHandle: { args: [FFIType.u32], returns: FFIType.ptr },
      GetFileType: { args: [FFIType.ptr], returns: FFIType.u32 },
      GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      WriteConsoleW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    return lib.symbols as unknown as Kernel32;
  } catch {
    return null;
  }
}

export type TerminalWriters = { out: Writer; err: Writer };

// console.log / console.error, the path used everywhere the fast path is not
// needed: other platforms, redirected output, or when the FFI is unavailable.
const fallback: TerminalWriters = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

export function createTerminal(): TerminalWriters {
  const k32 = loadKernel32();
  if (!k32) return fallback;

  const { ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const mode = new Uint32Array(1);

  function inspect(which: number): HandleState {
    const handle = k32!.GetStdHandle(which);
    return {
      fileType: k32!.GetFileType(handle),
      isConsole: k32!.GetConsoleMode(handle, ptr(mode)) !== 0,
    };
  }

  const wantOut = needsParentConsole(inspect(STD_OUTPUT_HANDLE));
  const wantErr = needsParentConsole(inspect(STD_ERROR_HANDLE));
  if (!wantOut && !wantErr) return fallback;

  // No parent console (started from Explorer, a shortcut or the Stream Deck):
  // there is nobody to talk to, and console.log is harmless.
  if (k32.AttachConsole(ATTACH_PARENT_PROCESS) === 0) return fallback;

  function consoleWriter(which: number, orElse: Writer): Writer {
    if (!inspect(which).isConsole) return orElse;
    const handle = k32!.GetStdHandle(which);
    const written = new Uint32Array(1);
    return (text) => {
      const buffer = Buffer.from(text + "\r\n", "utf16le");
      k32!.WriteConsoleW(handle, ptr(buffer), buffer.length / 2, ptr(written), null);
    };
  }

  return {
    out: wantOut ? consoleWriter(STD_OUTPUT_HANDLE, fallback.out) : fallback.out,
    err: wantErr ? consoleWriter(STD_ERROR_HANDLE, fallback.err) : fallback.err,
  };
}
