import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { PairedScreenInput, PairedScreenRequest, UserDeviceSummary } from "@rakazo/contracts";
import { pairedScreenFrame, USER_DEVICE_PATH } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { Button, Dialog, DialogContent, DialogTitle } from "@rakazo/ui-web";
import type { MouseEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { accountRequestHeaders } from "../../lib/auth/account-identity";
import { useSave } from "../../lib/query/query";
import { useEventListener } from "../../lib/use-event-listener";

type Frame = ReturnType<typeof pairedScreenFrame.parse>;
type PointerInput = Extract<PairedScreenInput, { kind: "pointer" }>;

async function request(
  deviceId: string,
  body: PairedScreenRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  const deadline = AbortSignal.timeout(body.action === "open" ? 66_000 : 9_000);
  const response = await fetch(`${USER_DEVICE_PATH}/${encodeURIComponent(deviceId)}/screen`, {
    method: "POST",
    headers: accountRequestHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    keepalive: body.action === "close",
  });
  const data = await readBoundedJsonResponse<{ result?: unknown }>(response, 1024 * 1024 + 256);
  if (!response.ok) throw new Error("Screen request failed");
  return data.result;
}

function coordinates(event: Pick<MouseEvent, "clientX" | "clientY">, target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const unit = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: unit((event.clientX - rect.left) / rect.width),
    y: unit((event.clientY - rect.top) / rect.height),
  };
}

function pointer(
  event: PointerEvent<HTMLElement>,
  phase: PointerInput["phase"],
  button: PointerInput["button"],
): PointerInput {
  return { kind: "pointer", phase, ...coordinates(event, event.currentTarget), button };
}

export function PairedScreenDialog({
  device,
  onClose,
}: {
  device: UserDeviceSummary;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [id, setId] = useState<string>();
  const [frame, setFrame] = useState<Frame>();
  const [controlId, setControlId] = useState<string>();
  const activeControl = useRef<string>(undefined);
  const [interrupted, setInterrupted] = useState(false);
  const activeId = useRef<string>(undefined);
  const lifetime = useRef<AbortController>(null);
  const dragging = useRef<PointerInput["button"]>(undefined);
  const queue = useRef<PairedScreenInput[]>([]);
  const flushing = useRef(false);
  const controlButton = useRef<HTMLButtonElement>(null);
  const focusAfterRelease = useRef(false);
  const [screenElement, setScreenElement] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (activeId.current)
        void request(device.deviceId, { action: "close", id: activeId.current }).catch(() => {});
    };
  }, [device.deviceId]);

  const open = useSave({
    save: async () => {
      const response = await request(device.deviceId, { action: "open" }, lifetime.current?.signal);
      if (
        typeof response !== "object" ||
        !response ||
        !("id" in response) ||
        typeof response.id !== "string"
      )
        throw new Error("Invalid paired screen session");
      activeId.current = response.id;
      return response.id;
    },
    onSaved: (sessionId) => setId(sessionId),
  });

  const control = useSave({
    save: async (action: "takeControl" | "releaseControl") => {
      if (!id) throw new Error("Screen unavailable");
      const signal = lifetime.current?.signal;
      if (action === "releaseControl") {
        const current = activeControl.current;
        activeControl.current = undefined;
        queue.current.length = 0;
        dragging.current = undefined;
        if (current) await request(device.deviceId, { action, id, controlId: current }, signal);
        return undefined;
      }
      const result = await request(device.deviceId, { action, id }, signal);
      if (
        typeof result !== "object" ||
        !result ||
        !("controlId" in result) ||
        typeof result.controlId !== "string"
      )
        throw new Error("Invalid takeover");
      return result.controlId;
    },
    onFailed: (_, action) => {
      if (id && action === "releaseControl") endView(id);
    },
    onSaved: (next) => {
      activeControl.current = next;
      dragging.current = undefined;
      queue.current.length = 0;
      setControlId(next);
    },
  });

  function endView(sessionId: string) {
    setInterrupted(true);
    activeControl.current = undefined;
    dragging.current = undefined;
    queue.current.length = 0;
    void request(device.deviceId, { action: "close", id: sessionId }).catch(() => {});
  }

  useTimeout(
    () => {
      if (!id) return;
      const signal = lifetime.current?.signal;
      void request(device.deviceId, { action: "frame", id }, signal)
        .then((response) => {
          if (!signal?.aborted) setFrame(pairedScreenFrame.parse(response));
        })
        .catch(() => {
          if (!signal?.aborted) endView(id);
        });
    },
    id && !interrupted ? (frame ? 180 : 0) : null,
    frame,
  );

  async function flushInput(sessionId: string, fence: string) {
    if (flushing.current) return;
    flushing.current = true;
    const signal = lifetime.current?.signal;
    try {
      while (!signal?.aborted && activeControl.current === fence) {
        const next = queue.current.shift();
        if (!next) break;
        await request(
          device.deviceId,
          { action: "input", id: sessionId, controlId: fence, input: next },
          signal,
        );
      }
    } catch {
      if (!signal?.aborted && activeControl.current === fence) endView(sessionId);
    } finally {
      flushing.current = false;
      const nextFence = activeControl.current;
      if (nextFence && queue.current.length) void flushInput(sessionId, nextFence);
    }
  }

  const taken = Boolean(controlId && !interrupted);
  const controlling = taken && !control.pending;
  useEffect(() => {
    if (!control.pending && focusAfterRelease.current) {
      focusAfterRelease.current = false;
      controlButton.current?.focus();
    }
  }, [control.pending]);
  function input(event: PairedScreenInput) {
    if (!id || !controlling || !controlId) return;
    const last = queue.current.at(-1);
    if (
      event.kind === "pointer" &&
      event.phase === "move" &&
      last?.kind === "pointer" &&
      last.phase === "move"
    ) {
      queue.current[queue.current.length - 1] = event;
    } else if (queue.current.length < 32) {
      queue.current.push(event);
    } else {
      // Close the input lease if this client cannot deliver ordered input.
      endView(id);
      return;
    }
    void flushInput(id, controlId);
  }

  useEventListener(
    controlling ? screenElement : null,
    "wheel",
    (event) => {
      event.preventDefault();
      if (screenElement && event.deltaY)
        input({
          kind: "wheel",
          ...coordinates(event, screenElement),
          delta: event.deltaY > 0 ? -120 : 120,
        });
    },
    { passive: false },
  );

  return (
    <Dialog
      open
      onOpenChange={(shown) => {
        if (!shown) onClose();
      }}
    >
      <DialogContent
        className="max-h-[95dvh] overflow-auto sm:max-w-5xl"
        aria-describedby={undefined}
      >
        <DialogTitle>{device.name}</DialogTitle>
        {!id ? (
          <>
            <Button className="w-fit" disabled={open.pending} onClick={() => open.run(undefined)}>
              <Trans>Request screen access</Trans>
            </Button>
            {open.pending ? (
              <p role="status">
                <Trans>Approve screen sharing on the Windows computer.</Trans>
              </p>
            ) : null}
            {open.error ? (
              <p role="alert">
                <Trans>
                  Could not open the screen. Check that Rakazo is up to date and the Windows desktop
                  is unlocked.
                </Trans>
              </p>
            ) : null}
          </>
        ) : null}
        {frame && !interrupted ? (
          <>
            <Button
              ref={controlButton}
              className="w-fit"
              disabled={control.pending}
              onClick={() => control.run(taken ? "releaseControl" : "takeControl")}
            >
              {taken ? <Trans>Release control</Trans> : <Trans>Take control</Trans>}
            </Button>
            {controlling ? (
              <p className="text-body-sm text-muted-foreground">
                <Trans>Press Shift+Esc to release control.</Trans>
              </p>
            ) : null}
            {control.error ? (
              <p role="alert">
                <Trans>
                  Could not change screen control. Wait for the current computer action to finish.
                </Trans>
              </p>
            ) : null}
            <div
              ref={setScreenElement}
              role="application"
              aria-label={t`Remote Windows screen`}
              tabIndex={controlling ? 0 : -1}
              className="relative mx-auto max-w-full touch-none overflow-hidden rounded-lg outline-focus"
              onPointerDown={(event) => {
                if (!controlling || dragging.current) return;
                const button = (["left", "middle", "right"] as const)[event.button];
                if (!button) return;
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                dragging.current = button;
                input(pointer(event, "down", button));
              }}
              onPointerMove={(event) => {
                input(pointer(event, "move", dragging.current ?? "left"));
              }}
              onPointerUp={(event) => {
                if (dragging.current) input(pointer(event, "up", dragging.current));
                dragging.current = undefined;
              }}
              onLostPointerCapture={(event) => {
                if (dragging.current) input(pointer(event, "up", dragging.current));
                dragging.current = undefined;
              }}
              onContextMenu={(event) => {
                if (controlling) event.preventDefault();
              }}
              onKeyDown={(event) => {
                if (!controlling || event.metaKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape" && event.shiftKey) {
                  focusAfterRelease.current = true;
                  control.run("releaseControl");
                  return;
                }
                if (event.key.length <= 32 && event.code.length <= 32)
                  input({
                    kind: "key",
                    key: event.key,
                    code: event.code,
                    ctrl: event.ctrlKey,
                    alt: event.altKey,
                    shift: event.shiftKey,
                  });
              }}
            >
              <img
                className="block max-h-[70dvh] w-auto max-w-full"
                draggable={false}
                src={`data:image/jpeg;base64,${frame.jpeg}`}
                alt=""
              />
            </div>
          </>
        ) : null}
        {id && !frame && !interrupted ? (
          <p role="status">
            <Trans>Connecting to the screen…</Trans>
          </p>
        ) : null}
        {interrupted ? (
          <p role="alert">
            <Trans>Screen sharing ended.</Trans>
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
