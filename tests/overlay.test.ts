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
    playResult: Promise.resolve() as Promise<void>,
    play() { return this.playResult; },
    sinkId: "",
    sinkCalls: 0,
    setSinkId(id: string) { this.sinkId = id; this.sinkCalls += 1; return Promise.resolve(); },
    pause: () => {},
    load: () => {},
    visible: () => classes.has("visible"),
  };
}

type Device = { deviceId: string; kind: string; label: string };

type Harness = {
  player: ReturnType<typeof fakeElement>;
  send: (event: unknown) => void;
  reloads: () => number;
  debug: () => boolean;
  reports: () => unknown[];
  permissionRequests: () => number;
  deviceChange: () => void;
  setDevices: (devices: Device[]) => void;
};

const SPEAKERS: Device = { deviceId: "spk", kind: "audiooutput", label: "Speakers (Realtek)" };
const HEADSET: Device = { deviceId: "hs", kind: "audiooutput", label: "Headset Earphone" };
const MIC: Device = { deviceId: "mic", kind: "audioinput", label: "Microphone" };

const tick = () => new Promise((done) => setTimeout(done, 0));

function loadOverlay(search = "", devices: Device[] = [SPEAKERS, HEADSET, MIC]): Harness {
  const script = OVERLAY_HTML.split("<script>")[1]!.split("</script>")[0]!;

  const player = fakeElement();
  const statusBox = fakeElement();
  let onmessage: ((event: { data: string }) => void) | null = null;

  const bodyClasses = new Set<string>();
  const document = {
    getElementById: (id: string) => (id === "player" ? player : statusBox),
    body: {
      classList: {
        add: (name: string) => bodyClasses.add(name),
        remove: (name: string) => bodyClasses.delete(name),
        contains: (name: string) => bodyClasses.has(name),
      },
    },
  };
  let reloads = 0;
  const location = { search, reload: () => { reloads += 1; } };

  const reports: unknown[] = [];
  const fetch = (url: string, init: { method: string; body: string }) => {
    if (url === "/audio-devices" && init.method === "POST") reports.push(JSON.parse(init.body));
    return Promise.resolve({ ok: true });
  };
  let permissionRequests = 0;
  const deviceListeners: Array<() => void> = [];
  const navigator = {
    mediaDevices: {
      enumerateDevices: () => Promise.resolve(devices.map((d) => ({ ...d }))),
      getUserMedia: () => {
        permissionRequests += 1;
        // Granting permission is what makes labels visible.
        devices = devices.map((d) => ({ ...d, label: d.label || d.deviceId + " label" }));
        return Promise.resolve({ getTracks: () => [{ stop: () => {} }] });
      },
      addEventListener: (type: string, handler: () => void) => {
        if (type === "devicechange") deviceListeners.push(handler);
      },
    },
  };
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

  new Function("document", "location", "EventSource", "URLSearchParams", "navigator", "fetch", script)(
    document,
    location,
    EventSource,
    URLSearchParams,
    navigator,
    fetch,
  );

  return {
    player,
    send(event: unknown) {
      if (!onmessage) throw new Error("overlay never attached its onmessage handler");
      onmessage({ data: JSON.stringify(event) });
    },
    reloads: () => reloads,
    debug: () => bodyClasses.has("debug"),
    reports: () => reports,
    permissionRequests: () => permissionRequests,
    deviceChange: () => deviceListeners.forEach((handler) => handler()),
    setDevices: (next) => { devices = next; },
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
  sink: "",
};
const CLIP_B = { ...CLIP_A, id: "2", name: "b.webm", file: "C:\\clips\\b.webm", src: "/media/2" };

let overlay: Harness;

beforeEach(async () => {
  overlay = loadOverlay();
  // Let the EventSource stub hand over its onmessage handler and the first
  // device report go out.
  await tick();
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

// play() rejects with AbortError when a new src interrupts it. That rejection
// belongs to the clip that was replaced and must not touch the new one.
test("a replaced clip's aborted play() does not mute the new clip", async () => {
  const aborted = Object.assign(new Error("interrupted"), { name: "AbortError" });
  overlay.player.playResult = Promise.reject(aborted);
  overlay.send(CLIP_A);
  overlay.player.playResult = Promise.resolve();
  overlay.send(CLIP_B);
  await new Promise((done) => setTimeout(done, 0));
  expect(overlay.player.src).toBe("/media/2");
  expect(overlay.player.muted).toBe(false);
  expect(overlay.player.visible()).toBe(true);
});

test("a genuine autoplay block retries muted", async () => {
  const blocked = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
  overlay.player.playResult = Promise.reject(blocked);
  overlay.send(CLIP_A);
  overlay.player.playResult = Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
  expect(overlay.player.muted).toBe(true);
  expect(overlay.player.visible()).toBe(true);
});

test("an autoplay block that lands after a replacement is ignored", async () => {
  const blocked = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
  overlay.player.playResult = Promise.reject(blocked);
  overlay.send(CLIP_A);
  overlay.player.playResult = Promise.resolve();
  overlay.send(CLIP_B);
  await new Promise((done) => setTimeout(done, 0));
  expect(overlay.player.muted).toBe(false);
  expect(overlay.player.src).toBe("/media/2");
});

test("?debug=1 turns the status box on", () => {
  expect(loadOverlay("?debug=1").debug()).toBe(true);
});

test("a parameter merely containing 'debug' does not", () => {
  expect(loadOverlay("?file=debugging.mp4").debug()).toBe(false);
});

// Audio output routing. Only the browser can see output devices, so the page
// reports them to the daemon and applies the daemon's chosen device itself.
test("output devices are reported to the daemon on load", () => {
  expect(overlay.reports()).toEqual([
    { devices: [{ id: "spk", label: "Speakers (Realtek)" }, { id: "hs", label: "Headset Earphone" }] },
  ]);
  expect(overlay.permissionRequests()).toBe(0);
});

test("hidden labels trigger one permission request before reporting", async () => {
  const unlabeled = [SPEAKERS, HEADSET].map((d) => ({ ...d, label: "" }));
  const page = loadOverlay("", unlabeled);
  await tick();
  expect(page.permissionRequests()).toBe(1);
  expect(page.reports()).toEqual([{ devices: [{ id: "spk", label: "spk label" }, { id: "hs", label: "hs label" }] }]);
});

test("a device change sends a fresh report", async () => {
  overlay.setDevices([HEADSET]);
  overlay.deviceChange();
  await tick();
  expect(overlay.reports()).toHaveLength(2);
  expect(overlay.reports()[1]).toEqual({ devices: [{ id: "hs", label: "Headset Earphone" }] });
});

test("no sink leaves the browser's output device alone", () => {
  overlay.send(CLIP_A);
  expect(overlay.player.sinkCalls).toBe(0);
});

test("a sink is matched against device labels, case-insensitively", () => {
  overlay.send({ ...CLIP_A, sink: "realtek" });
  expect(overlay.player.sinkId).toBe("spk");
  expect(overlay.player.visible()).toBe(true);
});

test("a sink can also be a device id", () => {
  overlay.send({ ...CLIP_A, sink: "hs" });
  expect(overlay.player.sinkId).toBe("hs");
});

test("an unknown sink plays on the default device", () => {
  overlay.send({ ...CLIP_A, sink: "Bluetooth" });
  expect(overlay.player.sinkId).toBe("");
  expect(overlay.player.visible()).toBe(true);
});

test("dropping the sink returns to the default device", () => {
  overlay.send({ ...CLIP_A, sink: "headset" });
  expect(overlay.player.sinkId).toBe("hs");
  overlay.send(CLIP_B);
  expect(overlay.player.sinkId).toBe("");
});

test("an already applied sink is not reapplied on every play", () => {
  overlay.send({ ...CLIP_A, sink: "headset" });
  overlay.send({ ...CLIP_B, sink: "headset" });
  expect(overlay.player.sinkCalls).toBe(1);
});
