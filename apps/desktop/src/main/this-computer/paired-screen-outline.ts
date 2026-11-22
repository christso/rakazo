import { BaseWindow, screen } from "electron";

type OutlineMode = "watching" | "controlling";
const COLORS: Record<OutlineMode, string> = {
  watching: "#2563eb",
  controlling: "#e85d04",
};
const WIDTH = 2;

export function createPairedScreenOutline() {
  const edges: BaseWindow[] = [];

  function hide() {
    for (const edge of edges.splice(0)) {
      if (!edge.isDestroyed()) edge.destroy();
    }
  }

  function show(mode: OutlineMode) {
    if (edges.length) {
      for (const edge of edges) edge.setBackgroundColor(COLORS[mode]);
      return;
    }

    const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
    try {
      for (const bounds of [
        { x, y, width, height: WIDTH },
        { x, y: y + height - WIDTH, width, height: WIDTH },
        { x, y: y + WIDTH, width: WIDTH, height: height - 2 * WIDTH },
        { x: x + width - WIDTH, y: y + WIDTH, width: WIDTH, height: height - 2 * WIDTH },
      ]) {
        const edge = new BaseWindow({
          ...bounds,
          backgroundColor: COLORS[mode],
          show: false,
          frame: false,
          thickFrame: false,
          focusable: false,
          skipTaskbar: true,
          resizable: false,
        });
        edges.push(edge);
        edge.setIgnoreMouseEvents(true);
        edge.setAlwaysOnTop(true, "pop-up-menu");
        edge.showInactive();
      }
    } catch (error) {
      hide();
      throw error;
    }
  }

  return {
    show,
    hide,
    visible: () =>
      edges.length === 4 && edges.every((edge) => !edge.isDestroyed() && edge.isVisible()),
  };
}
