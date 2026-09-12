import { test, expect } from "bun:test";
import { psQuote, buildTrayScript } from "../src/tray";

test("psQuote wraps in single quotes", () => {
  expect(psQuote("abc")).toBe("'abc'");
});

test("psQuote doubles embedded single quotes", () => {
  expect(psQuote("it's")).toBe("'it''s'");
});

test("the tray script embeds base and token quoted", () => {
  const script = buildTrayScript("http://127.0.0.1:4466", "to'ken");
  expect(script).toContain("$base = 'http://127.0.0.1:4466'");
  expect(script).toContain("$token = 'to''ken'");
  expect(script).not.toContain("__BASE__");
  expect(script).not.toContain("__TOKEN__");
});
