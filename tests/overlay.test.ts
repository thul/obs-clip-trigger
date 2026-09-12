// Runs the overlay page's script against a minimal fake DOM so the replace and
// toggle behaviour can be tested without a browser.
import { test, expect, beforeEach } from "bun:test";
import { OVERLAY_HTML } from "../src/overlay";

function fakeElement() {
  const classes = new Set<string>();
  const handlers: Record<string, Array<() => void>> = {};
  return {
    style: {} as Record<string, string>,
    textContent: "",
    volume: 1,
    muted: false,
    src: "",
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
    addEventListener(type: string, handler: () => void) {
      (handlers[type] ??= []).push(handler);
    },
    fire(type: string) {
      for (const handler of handlers[type] ?? []) handler();
    },
    getAttribute(name: string) {
      return name === "src" ? (this.src === "" ? null : this.src) : null;
    },
    removeAttribute(name: string) {
      if (name === "src") this.src = "";
    },
    play: () => Promise.resolve(),
    pause: () => {},
    load: () => {},
    visible: () => classes.has("visible"),
  };
}

type Harness = {
  player: ReturnType<typeof fakeElement>;
  send: (event: unknown) => void;
  reloads: () => number;
};

function loadOverlay(): Harness {
  const script = OVERLAY_HTML.split("<script>")[1]!.split("</script>")[0]!;

  const player = fakeElement();
  const statusBox = fakeElement();
  let onmessage: ((event: { data: string }) => void) | null = null;

  const document = {
    getElementById: (id: string) => (id === "player" ? player : statusBox),
    body: { classList: { add() {}, remove() {}, contains: () => false } },
  };
  let reloads = 0;
  const location = { search: "", reload: () => { reloads += 1; } };
  class EventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string) {
      queueMicrotask(() => {
        onmessage = this.onmessage;
      });
    }
  }

  new Function("document", "location", "EventSource", script)(document, location, EventSource);

  return {
    player,
    send(event: unknown) {
      const source = onmessage ?? (null as never);
      source({ data: JSON.stringify(event) });
    },
    reloads: () => reloads,
  };
}

const CLIP_A = {
  type: "play",
  id: "1",
  name: "a.webm",
  file: "C:\\clips\\a.webm",
  src: "/media/1",
  volume: 1,
  fit: "contain",
};
const CLIP_B = { ...CLIP_A, id: "2", name: "b.webm", file: "C:\\clips\\b.webm", src: "/media/2" };

let overlay: Harness;

beforeEach(async () => {
  overlay = loadOverlay();
  // Let the EventSource stub hand over its onmessage handler.
  await Promise.resolve();
});

test("starts hidden", () => {
  expect(overlay.player.visible()).toBe(false);
});

test("a trigger plays the clip and shows it", () => {
  overlay.send(CLIP_A);
  expect(overlay.player.visible()).toBe(true);
  expect(overlay.player.src).toBe("/media/1");
  expect(overlay.player.muted).toBe(false);
  expect(overlay.player.volume).toBe(1);
});

test("it hides itself when the clip ends", () => {
  overlay.send(CLIP_A);
  overlay.player.fire("ended");
  expect(overlay.player.visible()).toBe(false);
  expect(overlay.player.src).toBe("");
});

test("the same file again while playing toggles it off", () => {
  overlay.send(CLIP_A);
  overlay.send(CLIP_A);
  expect(overlay.player.visible()).toBe(false);
  expect(overlay.player.src).toBe("");
});

test("the same file after it finished plays it again", () => {
  overlay.send(CLIP_A);
  overlay.player.fire("ended");
  overlay.send(CLIP_A);
  expect(overlay.player.visible()).toBe(true);
  expect(overlay.player.src).toBe("/media/1");
});

test("toggling off mid-clip leaves the overlay empty", () => {
  overlay.send(CLIP_A);
  overlay.send(CLIP_A);
  expect(overlay.player.visible()).toBe(false);
  overlay.send(CLIP_B);
  expect(overlay.player.src).toBe("/media/2");
});

test("a different file replaces the clip that is playing", () => {
  overlay.send(CLIP_A);
  overlay.send(CLIP_B);
  expect(overlay.player.visible()).toBe(true);
  expect(overlay.player.src).toBe("/media/2");
});

test("the replaced clip does not come back when the new one ends", () => {
  overlay.send(CLIP_A);
  overlay.send(CLIP_B);
  overlay.player.fire("ended");
  expect(overlay.player.visible()).toBe(false);
  expect(overlay.player.src).toBe("");
});

test("the file that replaced another still toggles off", () => {
  overlay.send(CLIP_A);
  overlay.send(CLIP_B);
  overlay.send(CLIP_B);
  expect(overlay.player.visible()).toBe(false);
});

test("a file that was replaced can be triggered again", () => {
  overlay.send(CLIP_A);
  overlay.send(CLIP_B);
  overlay.send(CLIP_A);
  expect(overlay.player.visible()).toBe(true);
  expect(overlay.player.src).toBe("/media/1");
});

test("stop hides everything", () => {
  overlay.send(CLIP_A);
  overlay.send({ type: "stop" });
  expect(overlay.player.visible()).toBe(false);
  expect(overlay.player.src).toBe("");
});

// The page is stamped with the daemon's overlay version at serve time. In these
// tests it keeps the raw placeholder, so any other version counts as a mismatch.
test("a version mismatch reloads the page", () => {
  overlay.send({ type: "hello", version: "some-other-build" });
  expect(overlay.reloads()).toBe(1);
});

test("a matching version does not reload the page", () => {
  overlay.send({ type: "hello", version: "__OVERLAY_VERSION__" });
  expect(overlay.reloads()).toBe(0);
});

test("a hello does not disturb the clip that is playing", () => {
  overlay.send(CLIP_A);
  overlay.send({ type: "hello", version: "__OVERLAY_VERSION__" });
  expect(overlay.player.visible()).toBe(true);
  expect(overlay.player.src).toBe("/media/1");
});
