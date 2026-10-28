// Last sentence of the text, when it ends with a colon announcing the next action.
const ANNOUNCEMENT = /(^|[.!?]\s+|\n)((?=\w)(?:[^\n.!?]|[.!?](?=\S))+):$/;
const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||<|\s{4})/;
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function condenseStep(text: string, time: Date, final = true): string {
  const stamp = `[${time.toTimeString().slice(0, 5)}]`;
  const body = final ? text.replace(ANNOUNCEMENT, "$1**$2**.") : text;
  return BLOCK_START.test(body) ? `${stamp}\n\n${body}` : `${stamp} ${body}`;
}

// Hidden thinking leaves stacked spacer lines. The first line stays because it
// carries the terminal's prompt zone marker.
export function collapseLeadingBlanks(lines: string[]): string[] {
  const start = lines.findIndex(line => line.replace(ESCAPES, "").trim() !== "");
  if (start < 0) return [];
  return start <= 1 ? lines : [lines[0], ...lines.slice(start)];
}
