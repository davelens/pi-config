import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function fmt(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function applyFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((_tui, theme, _footerData) => {
    return {
      invalidate() {},
      render(): string[] {
        const usage = ctx.getContextUsage();
        const tokens = usage?.tokens ?? null;
        const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

        const percent = usage?.percent ?? null;
        const statsLine = theme.fg(
          "accent",
          `${tokens === null ? "?" : fmt(tokens)} / ${fmt(window)} (${percent === null ? "?" : percent.toFixed(0)}%)`,
        );

        return [statsLine];
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    applyFooter(ctx);
  });

  pi.registerCommand("condensed-footer", {
    description: "Re-apply the condensed tokens / context-window footer",
    handler: async (_args, ctx) => {
      applyFooter(ctx);
    },
  });
}
