import { randomUUID } from "node:crypto";
import type { PairedScreenInput, PairedScreenRequest } from "@rakazo/contracts";
import { abortableDelay } from "@rakazo/core";

const IDLE_MS = 12_000;
const MAX_SESSION_MS = 20 * 60_000;
const KEY_INPUT_SETTLE_MS = 75;

type View = {
  id: string;
  owner: string;
  expiresAt: number;
  controlId?: string;
  capturing?: boolean;
};

export function createPairedScreen(options: {
  confirm: (signal: AbortSignal) => Promise<boolean>;
  available: () => boolean;
  frame: () => Promise<string>;
  input: (input: PairedScreenInput) => void;
  releaseInput: () => void;
  outline: {
    show: (mode: "watching" | "controlling") => void;
    hide: () => void;
    visible: () => boolean;
  };
}) {
  let pending: AbortController | undefined;
  let view: View | undefined;
  let timer: NodeJS.Timeout | undefined;

  function clear() {
    pending?.abort();
    pending = undefined;
    clearTimeout(timer);
    const controlled = view?.controlId;
    view = undefined;
    try {
      if (controlled) options.releaseInput();
    } finally {
      options.outline.hide();
    }
  }

  function current() {
    if (
      view &&
      (Date.now() >= view.expiresAt || !options.available() || !options.outline.visible())
    )
      clear();
    return view;
  }

  function renew(next: View) {
    clearTimeout(timer);
    timer = setTimeout(clear, Math.min(IDLE_MS, next.expiresAt - Date.now()));
    timer.unref();
  }

  function showOutline(mode: "watching" | "controlling") {
    try {
      options.outline.show(mode);
      if (!options.outline.visible()) throw new Error("The screen sharing outline is unavailable");
    } catch (error) {
      clear();
      throw error;
    }
  }

  function requireView(owner: string, id: string) {
    const active = current();
    if (!active || active.owner !== owner || active.id !== id)
      throw new Error("Paired screen session ended");
    return active;
  }

  return {
    clear,
    controlling: () => Boolean(current()?.controlId),
    async request(
      owner: string,
      request: PairedScreenRequest,
      signal: AbortSignal,
      canTakeControl: () => boolean,
    ) {
      signal.throwIfAborted();
      if (request.action === "open") {
        if (pending || current() || !options.available())
          throw new Error("Paired screen is unavailable");
        const approval = new AbortController();
        pending = approval;
        try {
          const allowed = await options.confirm(AbortSignal.any([signal, approval.signal]));
          signal.throwIfAborted();
          if (pending !== approval || !allowed || !options.available())
            throw new Error("Screen sharing was refused");
          const next = {
            id: randomUUID(),
            owner,
            expiresAt: Date.now() + MAX_SESSION_MS,
          };
          showOutline("watching");
          view = next;
          renew(next);
          return { id: next.id };
        } finally {
          if (pending === approval) pending = undefined;
        }
      }

      const active = requireView(owner, request.id);
      switch (request.action) {
        case "frame":
          if (active.capturing) throw new Error("Screen capture is already running");
          active.capturing = true;
          try {
            const jpeg = await options.frame();
            signal.throwIfAborted();
            requireView(owner, request.id);
            renew(active);
            return { jpeg };
          } finally {
            active.capturing = false;
          }
        case "takeControl":
          if (!active.controlId && !canTakeControl())
            throw new Error("Wait for the bot's current computer action to end");
          if (!active.controlId) {
            showOutline("controlling");
            active.controlId = randomUUID();
          }
          return { controlId: active.controlId };
        case "input":
          if (active.controlId !== request.controlId)
            throw new Error("Take control before sending input");
          options.input(request.input);
          // Let the foreground Windows app process the key before the viewer sends another.
          if (request.input.kind === "key") await abortableDelay(KEY_INPUT_SETTLE_MS, signal);
          break;
        case "releaseControl":
          if (active.controlId !== request.controlId)
            throw new Error("Screen control session ended");
          active.controlId = undefined;
          options.releaseInput();
          showOutline("watching");
          break;
        case "close":
          clear();
          break;
      }
      return null;
    },
  };
}
