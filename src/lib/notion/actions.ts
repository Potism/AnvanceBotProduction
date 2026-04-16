import { Client } from "@notionhq/client";
import type {
  DatabaseObjectResponse,
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import type { BotConfig } from "../types";
import {
  fetchProductionPages,
  isTaskDone,
  toTaskRow,
  type TaskRow,
} from "./tasks";

type PropSchema = DatabaseObjectResponse["properties"][string];

async function getDatabaseSchema(cfg: BotConfig): Promise<DatabaseObjectResponse> {
  const client = new Client({ auth: cfg.notionToken });
  return (await client.databases.retrieve({
    database_id: cfg.notionDatabaseId,
  })) as DatabaseObjectResponse;
}

/** Shape a value for the Telegram id column in Production, regardless of type. */
function telegramIdValueForSchema(
  schema: PropSchema,
  telegramUserId: number,
): Record<string, unknown> {
  if (schema.type === "number") return { number: telegramUserId };
  if (schema.type === "rich_text") {
    return {
      rich_text: [
        { type: "text", text: { content: String(telegramUserId) } },
      ],
    };
  }
  if (schema.type === "title") {
    return {
      title: [{ type: "text", text: { content: String(telegramUserId) } }],
    };
  }
  throw new Error(
    `Unsupported Telegram id column type "${schema.type}". Use Number, Rich text, or Title.`,
  );
}

/**
 * Self-service link: stamp the caller's Telegram user id onto every OPEN Production
 * row whose Assignee matches. Safer than editing all historical rows; covers what
 * they care about right now (queue, upcoming work). Returns count of rows updated.
 */
export async function stampTelegramIdOnProductionForAssignee(
  cfg: BotConfig,
  telegramUserId: number,
  assigneeDisplay: string,
): Promise<{ updated: number; skipped: number }> {
  if (!assigneeDisplay.trim()) {
    throw new Error("Assignee display name is required.");
  }

  const schema = (await getDatabaseSchema(cfg)).properties;
  const tgProp = cfg.notionProps.telegramUserId;
  const tgSch = schema[tgProp];
  if (!tgSch) {
    const list = Object.keys(schema).sort().join(", ");
    throw new Error(
      `No "${tgProp}" column in Production. Available: ${list}. ` +
        `Add it (Number or Rich text) or set NOTION_PROP_TELEGRAM_USER_ID.`,
    );
  }

  const pages = await fetchProductionPages(cfg, "board");
  const needle = assigneeDisplay.trim().toLowerCase();
  const tgValue = telegramIdValueForSchema(tgSch, telegramUserId);

  const client = new Client({ auth: cfg.notionToken });
  let updated = 0;
  let skipped = 0;

  for (const page of pages) {
    const row = toTaskRow(page, cfg);
    const matches =
      row.assignee.toLowerCase().includes(needle) ||
      needle.includes(row.assignee.toLowerCase());
    if (!row.assignee || !matches) continue;
    if (isTaskDone(row.status)) {
      skipped += 1;
      continue;
    }
    if (row.telegramUserId === telegramUserId) {
      skipped += 1;
      continue;
    }
    try {
      await client.pages.update({
        page_id: page.id,
        properties: { [tgProp]: tgValue } as never,
      });
      updated += 1;
    } catch (e) {
      console.warn("[actions] stamp tg id failed for page", page.id, e);
    }
  }

  if (updated === 0 && skipped === 0) {
    throw new Error(
      `No open Production tasks matched assignee "${assigneeDisplay}".`,
    );
  }

  return { updated, skipped };
}

/** Reverse lookup: first open page with this assignee that already carries a Telegram id. */
export async function findTelegramIdForAssignee(
  cfg: BotConfig,
  assigneeDisplay: string,
): Promise<number | null> {
  const needle = assigneeDisplay.trim().toLowerCase();
  if (!needle) return null;
  const pages = await fetchProductionPages(cfg, "board");
  for (const p of pages) {
    const row = toTaskRow(p, cfg);
    if (!row.telegramUserId) continue;
    if (
      row.assignee.toLowerCase().includes(needle) ||
      needle.includes(row.assignee.toLowerCase())
    ) {
      return row.telegramUserId;
    }
  }
  return null;
}

/** All distinct Telegram ids currently present on open Production rows. */
export async function listLinkedTelegramIds(
  cfg: BotConfig,
): Promise<number[]> {
  const pages = await fetchProductionPages(cfg, "board");
  const set = new Set<number>();
  for (const p of pages) {
    const row = toTaskRow(p, cfg);
    if (row.telegramUserId) set.add(row.telegramUserId);
  }
  return [...set];
}

/** Update Status on a page (accepts status or select). Returns updated row. */
export async function updateTaskStatus(
  cfg: BotConfig,
  pageId: string,
  statusName: string,
): Promise<TaskRow | null> {
  const schema = (await getDatabaseSchema(cfg)).properties;
  const statusProp = cfg.notionProps.status;
  const sch = schema[statusProp];
  if (!sch) throw new Error(`No "${statusProp}" column in Production.`);

  let value: Record<string, unknown>;
  if (sch.type === "status") {
    value = { status: { name: statusName } };
  } else if (sch.type === "select") {
    value = { select: { name: statusName } };
  } else {
    throw new Error(
      `Status column is "${sch.type}"; expected status or select.`,
    );
  }

  const client = new Client({ auth: cfg.notionToken });
  const updated = (await client.pages.update({
    page_id: pageId,
    properties: { [statusProp]: value } as never,
  })) as PageObjectResponse;
  return toTaskRow(updated, cfg);
}

/** Push Due date N days forward (min 1). Returns updated row. */
export async function snoozeTaskDue(
  cfg: BotConfig,
  pageId: string,
  days: number,
): Promise<TaskRow | null> {
  const client = new Client({ auth: cfg.notionToken });
  const page = (await client.pages.retrieve({
    page_id: pageId,
  })) as PageObjectResponse;
  const dueProp = cfg.notionProps.due;
  const p = page.properties[dueProp];
  const bumpDays = Math.max(1, Math.trunc(days));

  const base = new Date();
  let currentStart: string | null = null;
  if (p?.type === "date" && p.date?.start) currentStart = p.date.start;
  const fromISO = currentStart
    ? new Date(currentStart.slice(0, 10) + "T12:00:00.000Z")
    : new Date(
        Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()),
      );
  fromISO.setUTCDate(fromISO.getUTCDate() + bumpDays);
  const nextStart = fromISO.toISOString().slice(0, 10);

  const updated = (await client.pages.update({
    page_id: pageId,
    properties: {
      [dueProp]: { date: { start: nextStart } } as never,
    },
  })) as PageObjectResponse;
  return toTaskRow(updated, cfg);
}

/** Get available Status option names (for building dynamic buttons). */
export async function fetchStatusOptionNames(
  cfg: BotConfig,
): Promise<string[]> {
  const schema = (await getDatabaseSchema(cfg)).properties;
  const sch = schema[cfg.notionProps.status];
  if (!sch) return [];
  if (sch.type === "status") {
    return sch.status?.options?.map((o) => o.name).filter(Boolean) ?? [];
  }
  if (sch.type === "select") {
    return sch.select?.options?.map((o) => o.name).filter(Boolean) ?? [];
  }
  return [];
}
