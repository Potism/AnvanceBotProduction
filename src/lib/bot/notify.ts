import type { BotConfig } from "../types";
import {
  findTelegramIdForAssignee,
  listLinkedTelegramIds,
} from "../notion/actions";
import {
  fetchProductionTasks,
  fetchTaskById,
  isTaskDone,
  type TaskRow,
} from "../notion/tasks";
import {
  sendMessageHtml,
  taskActionKeyboard,
} from "../telegram/client";
import {
  escapeHtml,
  formatDigestLine,
  formatTaskCard,
  headerLine,
  splitTelegramHtml,
} from "../telegram/format";

/** In-memory, best-effort dedupe for webhook spam (same isolate only). */
const recent = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60_000;

function isDuplicate(key: string): boolean {
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > DEDUP_WINDOW_MS) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

async function dmTaskCard(
  cfg: BotConfig,
  telegramId: number,
  title: string,
  row: TaskRow,
): Promise<void> {
  const body = `${headerLine(title)}\n\n${formatTaskCard(row)}`;
  await sendMessageHtml(
    cfg.telegramBotToken,
    telegramId,
    body,
    taskActionKeyboard(row.id, row.url),
  ).catch((e) => {
    console.warn("[notify] DM failed", telegramId, (e as Error).message);
  });
}

/** Dispatch from Notion webhook page events (created / properties_updated). */
export async function notifyFromNotionEvent(
  cfg: BotConfig,
  eventType: string,
  pageId: string,
): Promise<void> {
  if (!pageId) return;

  const row = await fetchTaskById(cfg, pageId);
  if (!row) return;

  if (eventType === "page.created") {
    if (isTaskDone(row.status)) return;
    const target =
      row.telegramUserId ??
      (row.assignee
        ? await findTelegramIdForAssignee(cfg, row.assignee)
        : null);
    if (!target) return;
    const key = `created:${pageId}:${target}`;
    if (isDuplicate(key)) return;
    await dmTaskCard(cfg, target, "New task assigned", row);
    return;
  }

  if (eventType === "page.properties_updated" || eventType === "page.updated") {
    if (isTaskDone(row.status)) return;
    const target =
      row.telegramUserId ??
      (row.assignee
        ? await findTelegramIdForAssignee(cfg, row.assignee)
        : null);
    if (!target) return;
    const status = row.status.toLowerCase();
    const isHot =
      status.includes("changes requested") ||
      status.includes("client review") ||
      status.includes("internal review");
    if (!isHot) return;
    const key = `upd:${pageId}:${status}:${target}`;
    if (isDuplicate(key)) return;
    await dmTaskCard(cfg, target, `Status: ${row.status}`, row);
  }
}

/** Morning digest: DM each linked teammate their open today+week queue. */
export async function sendMorningDigest(cfg: BotConfig): Promise<{
  recipients: number;
  sent: number;
}> {
  const tgIds = await listLinkedTelegramIds(cfg);
  let sent = 0;

  for (const tg of tgIds) {
    try {
      const today = await fetchProductionTasks(cfg, "today", undefined, tg);
      const week = await fetchProductionTasks(cfg, "week", undefined, tg);
      const weekOnly = week.filter((w) => !today.some((t) => t.id === w.id));
      const overdue = (
        await fetchProductionTasks(cfg, "overdue", undefined, tg)
      ).slice(0, 10);

      if (today.length === 0 && weekOnly.length === 0 && overdue.length === 0) {
        continue;
      }

      const sections: string[] = [headerLine("Morning digest")];
      if (overdue.length) {
        sections.push(
          `<b>⏰ Overdue</b> (${overdue.length})\n` +
            overdue.map(formatDigestLine).join("\n"),
        );
      }
      if (today.length) {
        sections.push(
          `<b>📅 Today</b> (${today.length})\n` +
            today.map(formatDigestLine).join("\n"),
        );
      }
      if (weekOnly.length) {
        sections.push(
          `<b>🗓 Rest of week</b> (${weekOnly.length})\n` +
            weekOnly.map(formatDigestLine).join("\n"),
        );
      }
      sections.push(
        `<i>Tap /mine for cards with actions, /today to focus.</i>`,
      );
      const body = sections.join("\n\n");

      for (const part of splitTelegramHtml(body)) {
        await sendMessageHtml(cfg.telegramBotToken, tg, part).catch(() => {});
      }
      sent += 1;
    } catch (e) {
      console.warn("[digest] failed for", tg, (e as Error).message);
    }
  }

  return { recipients: tgIds.length, sent };
}

/** Short confirmation card after a user action updates a task. */
export function actionAckText(action: string, row: TaskRow): string {
  return `✅ <b>${escapeHtml(action)}</b>\n\n${formatTaskCard(row)}`;
}
