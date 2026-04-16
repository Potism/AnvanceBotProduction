import type { TaskRow } from "../notion/tasks";

const BRAND = "Anvance Production";

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function headerLine(title: string): string {
  return `<b>${escapeHtml(BRAND)}</b> · ${escapeHtml(title)}`;
}

export function formatTaskBlocks(rows: TaskRow[]): string {
  if (!rows.length) {
    return `<i>No tasks found for this view.</i>`;
  }

  const chunks: string[] = [];
  for (const r of rows) {
    const lines: string[] = [];
    lines.push(`<b>${escapeHtml(r.title || "Untitled")}</b>`);
    if (r.client) lines.push(`Client: ${escapeHtml(r.client)}`);
    if (r.deliverable) lines.push(`Deliverable: ${escapeHtml(r.deliverable)}`);
    if (r.priority) lines.push(`Priority: ${escapeHtml(r.priority)}`);
    if (r.due) lines.push(`Due: ${escapeHtml(r.due)}`);
    if (r.shoot) lines.push(`Shoot / live: ${escapeHtml(r.shoot)}`);
    if (r.status) lines.push(`Status: ${escapeHtml(r.status)}`);
    if (r.serviceLine) lines.push(`Service: ${escapeHtml(r.serviceLine)}`);
    chunks.push(lines.join("\n"));
  }
  return chunks.join("\n\n────────\n\n");
}

export function splitTelegramHtml(
  text: string,
  maxLen = 3900,
): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length) {
    if (rest.length <= maxLen) {
      parts.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return parts;
}
