import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPairedScreen } from "./paired-screen.js";

function fixture(confirm = async (_signal: AbortSignal) => true) {
  const input = vi.fn();
  const releaseInput = vi.fn();
  const outline = { show: vi.fn(), hide: vi.fn(), visible: vi.fn(() => true) };
  const screen = createPairedScreen({
    confirm,
    available: () => true,
    frame: async () => "test-jpeg",
    input,
    releaseInput,
    outline,
  });
  const signal = new AbortController().signal;
  const owner = "owner-session";
  const open = async () => {
    const result = await screen.request(owner, { action: "open" }, signal, () => true);
    if (!result || !("id" in result) || typeof result.id !== "string")
      throw new Error("Missing screen session");
    return result.id;
  };
  return { screen, signal, owner, open, input, releaseInput, outline };
}

describe("paired Windows screen authority", () => {
  afterEach(() => vi.useRealTimers());

  it("requires viewing consent, restricts input to the same session, and releases it", async () => {
    const { screen, owner, signal, open, input, releaseInput, outline } = fixture();
    const id = await open();
    const event = { kind: "wheel", x: 0.3, y: 0.6, delta: 120 } as const;
    const stale = "a333c86a-20b2-47c7-a481-f7302d832a4e";
    await expect(
      screen.request(owner, { action: "frame", id }, signal, () => true),
    ).resolves.toEqual({ jpeg: "test-jpeg" });
    await expect(
      screen.request(
        owner,
        { action: "input", id, controlId: stale, input: event },
        signal,
        () => true,
      ),
    ).rejects.toThrow("Take control");
    await expect(
      screen.request("other-session", { action: "takeControl", id }, signal, () => true),
    ).rejects.toThrow("session ended");
    await expect(
      screen.request(owner, { action: "takeControl", id }, signal, () => false),
    ).rejects.toThrow("current computer action");
    const granted = await screen.request(owner, { action: "takeControl", id }, signal, () => true);
    if (!granted || !("controlId" in granted) || !granted.controlId)
      throw new Error("Missing control");
    const controlId = granted.controlId;
    await screen.request(
      owner,
      { action: "input", id, controlId, input: event },
      signal,
      () => true,
    );
    expect(outline.show.mock.calls).toEqual([["watching"], ["controlling"]]);
    expect(input).toHaveBeenCalledExactlyOnceWith(event);
    expect(screen.controlling()).toBe(true);
    await screen.request(owner, { action: "releaseControl", id, controlId }, signal, () => true);
    expect(releaseInput).toHaveBeenCalledOnce();
    expect(screen.controlling()).toBe(false);
    expect(outline.show).toHaveBeenLastCalledWith("watching");
    await screen.request(owner, { action: "takeControl", id }, signal, () => true);
    await expect(
      screen.request(owner, { action: "input", id, controlId, input: event }, signal, () => true),
    ).rejects.toThrow("Take control");
    expect(input).toHaveBeenCalledOnce();
    await screen.request(owner, { action: "close", id }, signal, () => true);
    expect(outline.hide).toHaveBeenCalledOnce();
    await expect(
      screen.request(owner, { action: "frame", id }, signal, () => true),
    ).rejects.toThrow("session ended");
  });

  it("paces keyboard input from the viewer", async () => {
    vi.useFakeTimers();
    const { screen, owner, signal, open, input } = fixture();
    const id = await open();
    const granted = await screen.request(owner, { action: "takeControl", id }, signal, () => true);
    if (!granted || !("controlId" in granted) || !granted.controlId)
      throw new Error("Missing control");
    const key = {
      kind: "key",
      key: "s",
      code: "KeyS",
      alt: false,
      shift: false,
      ctrl: false,
    } as const;
    const acknowledged = vi.fn();
    const pending = screen
      .request(
        owner,
        { action: "input", id, controlId: granted.controlId, input: key },
        signal,
        () => true,
      )
      .then(acknowledged);
    await vi.advanceTimersByTimeAsync(74);
    expect(input).toHaveBeenCalledExactlyOnceWith(key);
    expect(acknowledged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(acknowledged).toHaveBeenCalledOnce();
    screen.clear();
  });

  it("requires a visible outline to open and continue a screen session", async () => {
    const { screen, owner, signal, open, outline, releaseInput } = fixture();
    outline.visible.mockReturnValue(false);
    await expect(open()).rejects.toThrow("outline is unavailable");
    outline.visible.mockReturnValue(true);
    const id = await open();
    await screen.request(owner, { action: "takeControl", id }, signal, () => true);
    outline.visible.mockReturnValue(false);
    await expect(
      screen.request(owner, { action: "frame", id }, signal, () => true),
    ).rejects.toThrow("session ended");
    expect(releaseInput).toHaveBeenCalledOnce();
    expect(outline.hide).toHaveBeenCalledTimes(2);
  });

  it("ignores a local approval that arrives after the device disconnects", async () => {
    const approval = deferred<boolean>();
    const { screen, open } = fixture(() => approval.promise);
    const pending = open();
    screen.clear();
    approval.resolve(true);
    await expect(pending).rejects.toThrow("refused");
    expect(screen.controlling()).toBe(false);
  });

  it("expires a disconnected viewer and releases held input", async () => {
    vi.useFakeTimers();
    const { screen, owner, signal, open, releaseInput } = fixture();
    const id = await open();
    await screen.request(owner, { action: "takeControl", id }, signal, () => true);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(screen.controlling()).toBe(false);
    expect(releaseInput).toHaveBeenCalledOnce();
    await expect(
      screen.request(owner, { action: "frame", id }, signal, () => true),
    ).rejects.toThrow("session ended");
  });
});
