import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { addSessionToPowerline } from "./powerline-line.ts";

export default function sessionBreadcrumb(pi: ExtensionAPI) {
  let activeTui: { requestRender(): void } | undefined;

  pi.on("session_start", (_event, ctx) => {
    const powerlineEditor = ctx.ui.getEditorComponent();
    if (!powerlineEditor) return;

    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      activeTui = tui;
      const editor = powerlineEditor(tui, editorTheme, keybindings);
      const render = editor.render.bind(editor);

      editor.render = (width: number) => {
        const lines = render(width);
        const name = pi.getSessionName();

        if (name && lines[0]) {
          const session =
            ctx.ui.theme.fg("dim", "  ") +
            ctx.ui.theme.fg("accent", ` ${name}`) +
            " ";
          lines[0] = addSessionToPowerline(
            lines[0],
            session,
            visibleWidth,
            truncateToWidth,
          );
        }

        return lines;
      };

      return editor;
    });
  });

  pi.on("session_info_changed", () => activeTui?.requestRender());
  pi.on("session_shutdown", () => {
    activeTui = undefined;
  });
}
