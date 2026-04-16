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

function priorityGlyph(p: string): string {
  const t = p.toLowerCase();
  if (t.startsWith("p0")) return "🚨";
  if (t.startsWith("p1")) return "🔴";
  if (t.startsWith("p2")) return "🟠";
  if (t.startsWith("p3")) return "🟡";
  return "";
}

function statusGlyph(s: string): string {
  const t = s.toLowerCase();
  if (t.includes("changes requested")) return "↩️";
  if (t.includes("client review")) return "👁";
  if (t.includes("internal review")) return "🔍";
  if (t.includes("in production")) return "🛠";
  if (t.includes("briefing") || t.includes("brief")) return "📝";
  if (t.includes("approved")) return "✅";
  if (t.includes("scheduled")) return "📆";
  if (t.includes("done") || t.includes("shipped")) return "✔️";
  return "•";
}

function relativeDue(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return iso;
  const todayUTC = new Date();
  const today = new Date(
    Date.UTC(
      todayUTC.getUTCFullYear(),
      todayUTC.getUTCMonth(),
      todayUTC.getUTCDate(),
    ),
  );
  const d = new Date(m[1] + "T12:00:00.000Z");
  const diff = Math.round(
    (d.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diff === 0) return `${iso} · today`;
  if (diff === 1) return `${iso} · tomorrow`;
  if (diff === -1) return `${iso} · yesterday`;
  if (diff > 1 && diff <= 7) return `${iso} · in ${diff}d`;
  if (diff < -1) return `${iso} · ${Math.abs(diff)}d overdue`;
  return iso;
}

/** Render a single task card (no inline keyboard — caller adds that per message). */
export function formatTaskCard(r: TaskRow): string {
  const pr = priorityGlyph(r.priority);
  const st = statusGlyph(r.status);
  const title = `<b>${pr ? pr + " " : ""}${escapeHtml(r.title || "Untitled")}</b>`;
  const lines: string[] = [title];

  const metaBits: string[] = [];
  if (r.client) metaBits.push(escapeHtml(r.client));
  if (r.deliverable) metaBits.push(escapeHtml(r.deliverable));
  if (metaBits.length) lines.push(`<i>${metaBits.join(" · ")}</i>`);

  if (r.status) lines.push(`${st} ${escapeHtml(r.status)}`);
  if (r.priority && !pr) lines.push(`Priority: ${escapeHtml(r.priority)}`);

  if (r.due) lines.push(`📅 Due: ${escapeHtml(relativeDue(r.due))}`);
  if (r.shoot) lines.push(`🎬 Shoot/live: ${escapeHtml(relativeDue(r.shoot))}`);
  if (r.assignee) lines.push(`👤 ${escapeHtml(r.assignee)}`);
  if (r.reviewer) lines.push(`🧐 Reviewer: ${escapeHtml(r.reviewer)}`);

  return lines.join("\n");
}

/** Legacy bulk renderer (still used where we send one big message). */
export function formatTaskBlocks(rows: TaskRow[]): string {
  if (!rows.length) return `<i>No tasks found for this view.</i>`;
  return rows.map(formatTaskCard).join("\n\n────────\n\n");
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

/** Compact digest line for morning summary (single line per task). */
export function formatDigestLine(r: TaskRow): string {
  const pr = priorityGlyph(r.priority);
  const st = statusGlyph(r.status);
  const title = escapeHtml(r.title || "Untitled");
  const due = r.due ? ` · 📅 ${escapeHtml(relativeDue(r.due))}` : "";
  const shoot = r.shoot ? ` · 🎬 ${escapeHtml(relativeDue(r.shoot))}` : "";
  const client = r.client ? ` <i>${escapeHtml(r.client)}</i>` : "";
  const prefix = pr ? `${pr} ` : "";
  return `${prefix}${st} <b>${title}</b>${client}${due}${shoot}`;
}
