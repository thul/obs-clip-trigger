// HTTP Range header parsing for a single byte range.
//
// Returns the inclusive byte span to serve, or null when the header is
// malformed, asks for more than one range, or cannot be satisfied for a file
// of the given size (the caller answers 416).

export type ByteRange = { start: number; end: number };

export function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, first, last] = match;
  let start: number;
  let end: number;

  if (first === "") {
    // Suffix range: the last N bytes of the file.
    if (last === "") return null;
    const suffix = Number(last);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  }

  if (start > end || start >= size) return null;
  return { start, end };
}
