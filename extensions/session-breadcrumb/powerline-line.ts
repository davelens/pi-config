type VisibleWidth = (text: string) => number;
type TruncateToWidth = (text: string, width: number, ellipsis?: string) => string;

export function addSessionToPowerline(
  line: string,
  session: string,
  visibleWidth: VisibleWidth,
  truncateToWidth: TruncateToWidth,
): string {
  const borderStart = line.lastIndexOf(" ");
  if (!session || borderStart < 0) return line;

  const border = line.slice(borderStart + 1);
  if (!border.includes("─")) return line;

  const prefix = line.slice(0, borderStart);
  const width = visibleWidth(line);
  const sessionWidth = width - visibleWidth(prefix) - 2;
  if (sessionWidth <= 0) return line;

  const displayedSession = truncateToWidth(session, sessionWidth, "...");
  const borderWidth = width - visibleWidth(prefix) - visibleWidth(displayedSession);

  return prefix + displayedSession + truncateToWidth(border, borderWidth, "");
}
