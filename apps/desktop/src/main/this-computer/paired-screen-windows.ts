import type { PairedScreenInput } from "@rakazo/contracts";
import { desktopCapturer, powerMonitor, screen } from "electron";
import koffi from "koffi";
import { createPairedScreen } from "./paired-screen.js";
import { createPairedScreenOutline } from "./paired-screen-outline.js";

const buttons = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

const specialKeys: Readonly<Record<string, number>> = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
};

function virtualKey(code: string) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return 0x6f + Number(code.slice(1));
  return Object.hasOwn(specialKeys, code) ? specialKeys[code] : undefined;
}

function createWindowsScreenInput() {
  const user32 = koffi.load("user32.dll");
  const setCursor = user32.func("int __stdcall SetCursorPos(int, int)");
  const mouse = user32.func(
    "void __stdcall mouse_event(uint32_t, uint32_t, uint32_t, uint32_t, uintptr_t)",
  );
  const send = user32.func("uint32_t __stdcall SendInput(uint32_t, void *, int)");
  const wide = koffi.sizeof("void *") === 8;
  // INPUT begins with a DWORD and an aligned union. KEYBDINPUT is its keyboard member.
  const inputSize = wide ? 40 : 28;
  const keyboardOffset = wide ? 8 : 4;
  const held = new Set<keyof typeof buttons>();

  type Key = { vk?: number; text?: number; up?: boolean };
  function keyBuffer(keys: Key[]) {
    const input = Buffer.alloc(keys.length * inputSize);
    keys.forEach(({ vk, text, up }, index) => {
      const row = index * inputSize;
      input.writeUInt32LE(1, row); // INPUT_KEYBOARD
      input.writeUInt16LE(vk ?? 0, row + keyboardOffset);
      input.writeUInt16LE(text ?? 0, row + keyboardOffset + 2);
      const extended = vk !== undefined && vk >= 0x21 && vk <= 0x2e;
      input.writeUInt32LE(
        (extended ? 1 : 0) | (up ? 2 : 0) | (text ? 4 : 0),
        row + keyboardOffset + 4,
      );
    });
    return input;
  }

  function keyboard(keys: Key[]) {
    const written = send(keys.length, keyBuffer(keys), inputSize);
    if (written === keys.length) return;
    const down = new Map<string, Key>();
    for (const key of keys.slice(0, written)) {
      const identity = key.vk === undefined ? `text:${key.text}` : `vk:${key.vk}`;
      if (key.up) down.delete(identity);
      else down.set(identity, key);
    }
    const release = [...down.values()].reverse().map((key) => ({ ...key, up: true }));
    if (release.length) send(release.length, keyBuffer(release), inputSize);
    throw new Error("Windows refused keyboard input");
  }

  function key(event: Extract<PairedScreenInput, { kind: "key" }>) {
    if (!event.ctrl && !event.alt && [...event.key].length === 1) {
      const units = Array.from({ length: event.key.length }, (_, index) =>
        event.key.charCodeAt(index),
      );
      keyboard(units.flatMap((text) => [{ text }, { text, up: true }]));
      return;
    }
    const vk = virtualKey(event.code);
    if (!vk) return;
    const modifiers = [
      ...(event.shift ? [0x10] : []),
      ...(event.ctrl ? [0x11] : []),
      ...(event.alt ? [0x12] : []),
    ];
    keyboard([
      ...modifiers.map((value) => ({ vk: value })),
      { vk },
      { vk, up: true },
      ...modifiers.reverse().map((value) => ({ vk: value, up: true })),
    ]);
  }

  return {
    input(event: PairedScreenInput) {
      if (event.kind === "key") {
        key(event);
        return;
      }
      const { bounds } = screen.getPrimaryDisplay();
      const pt = screen.dipToScreenPoint({
        x: bounds.x + Math.round(event.x * (bounds.width - 1)),
        y: bounds.y + Math.round(event.y * (bounds.height - 1)),
      });
      if (!setCursor(pt.x, pt.y)) throw new Error("Windows refused pointer input");
      if (event.kind === "wheel") {
        mouse(0x0800, 0, 0, event.delta >>> 0, 0);
        return;
      }
      if (event.phase === "down" && !held.has(event.button)) {
        mouse(buttons[event.button].down, 0, 0, 0, 0);
        held.add(event.button);
      }
      if (event.phase === "up" && held.delete(event.button))
        mouse(buttons[event.button].up, 0, 0, 0, 0);
    },
    release() {
      for (const button of held) mouse(buttons[button].up, 0, 0, 0, 0);
      held.clear();
    },
  };
}

async function capturePrimaryWindowsScreen() {
  const display = screen.getPrimaryDisplay();
  const scale = Math.min(1, 1280 / Math.max(display.size.width, display.size.height));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const match = sources.find((source) => source.display_id === String(display.id));
  const source = match ?? (sources.length === 1 ? sources[0] : undefined);
  if (!source || source.thumbnail.isEmpty()) throw new Error("Windows screen is unavailable");
  return source.thumbnail.toJPEG(60).toString("base64");
}

export function createWindowsPairedScreen(confirm: (signal: AbortSignal) => Promise<boolean>) {
  let input: ReturnType<typeof createWindowsScreenInput> | undefined;
  const access = createPairedScreen({
    confirm,
    outline: createPairedScreenOutline(),
    available: () => {
      const state = powerMonitor.getSystemIdleState(1);
      return state === "active" || state === "idle";
    },
    frame: capturePrimaryWindowsScreen,
    input: (event) => {
      input ??= createWindowsScreenInput();
      input.input(event);
    },
    releaseInput: () => input?.release(),
  });
  powerMonitor.on("lock-screen", access.clear);
  powerMonitor.on("suspend", access.clear);
  screen.on("display-added", access.clear);
  screen.on("display-removed", access.clear);
  screen.on("display-metrics-changed", access.clear);
  return access;
}
