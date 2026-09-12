import { test, expect } from "bun:test";
import { parseRange } from "../src/range";

const SIZE = 1000;

test("a plain start-end range", () => {
  expect(parseRange("bytes=0-499", SIZE)).toEqual({ start: 0, end: 499 });
});

test("an open-ended range runs to the last byte", () => {
  expect(parseRange("bytes=200-", SIZE)).toEqual({ start: 200, end: 999 });
});

test("an end past the file is clamped", () => {
  expect(parseRange("bytes=900-5000", SIZE)).toEqual({ start: 900, end: 999 });
});

test("a suffix range is the last N bytes", () => {
  expect(parseRange("bytes=-100", SIZE)).toEqual({ start: 900, end: 999 });
});

test("a suffix range larger than the file is the whole file", () => {
  expect(parseRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
});

test("surrounding whitespace is tolerated", () => {
  expect(parseRange("  bytes=0-1 ", SIZE)).toEqual({ start: 0, end: 1 });
});

test("a start past the end is unsatisfiable", () => {
  expect(parseRange("bytes=1000-", SIZE)).toBeNull();
  expect(parseRange("bytes=500-499", SIZE)).toBeNull();
});

test("an empty suffix is unsatisfiable", () => {
  expect(parseRange("bytes=-0", SIZE)).toBeNull();
  expect(parseRange("bytes=-", SIZE)).toBeNull();
});

test("malformed or multi-range headers are rejected", () => {
  expect(parseRange("bytes=a-b", SIZE)).toBeNull();
  expect(parseRange("bytes=0-1,5-6", SIZE)).toBeNull();
  expect(parseRange("items=0-1", SIZE)).toBeNull();
});

test("any range on an empty file is unsatisfiable", () => {
  expect(parseRange("bytes=0-", 0)).toBeNull();
});
