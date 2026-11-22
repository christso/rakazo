import { BaseWindow, screen, View } from "electron";

type OutlineMode = "watching" | "controlling";
const COLORS: Record<OutlineMode, string> = {
  watching: "#2563eb",
  controlling: "#e85d04",
};
const WIDTH = 2;

export function createPairedScreenOutline() {
  let overlay: { window: BaseWindow; edges: View[] } | undefined;

  function hide() {
    const current = overlay;
    overlay = undefined;
    if (current && !current.window.isDestroyed()) current.window.destroy();
  }

  function show(mode: OutlineMode) {
    if (overlay && !overlay.window.isDestroyed()) {
      for (const edge of overlay.edges) edge.setBackgroundColor(COLORS[mode]);
      return;
    }

    const workArea = screen.getPrimaryDisplay().workArea;
    const { width, height } = workArea;
    // Keep the desktop visible between the strips, including on Windows at high DPI.
    const window = new BaseWindow({
      ...workArea,
      backgroundColor: "#00000000",
      transparent: true,
      show: false,
      frame: false,
      thickFrame: false,
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
    });
    const edges: View[] = [];
    overlay = { window, edges };
    try {
      for (const bounds of [
        { x: 0, y: 0, width, height: WIDTH },
        { x: 0, y: height - WIDTH, width, height: WIDTH },
        { x: 0, y: WIDTH, width: WIDTH, height: height - 2 * WIDTH },
        { x: width - WIDTH, y: WIDTH, width: WIDTH, height: height - 2 * WIDTH },
      ]) {
        const edge = new View();
        edge.setBounds(bounds);
        edge.setBackgroundColor(COLORS[mode]);
        window.contentView.addChildView(edge);
        edges.push(edge);
      }
      window.setIgnoreMouseEvents(true);
      window.setAlwaysOnTop(true, "pop-up-menu");
      window.showInactive();
    } catch (error) {
      hide();
      throw error;
    }
  }

  return {
    show,
    hide,
    visible: () => Boolean(overlay && !overlay.window.isDestroyed() && overlay.window.isVisible()),
  };
}
