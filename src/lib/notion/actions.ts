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

/** Forward lookup: assignee display for a Telegram id (first open row wins). */
export async function findAssigneeForTelegramId(
  cfg: BotConfig,
  telegramUserId: number,
): Promise<string | null> {
  const pages = await fetchProductionPages(cfg, "board");
  for (const p of pages) {
    const row = toTaskRow(p, cfg);
    if (row.telegramUserId === telegramUserId && row.assignee) {
      return row.assignee;
    }
  }
  return null;
}

/**
 * Send a task for client approval:
 *   - sets "Client approval" = "Sent" (when that column exists as select)
 *   - optionally advances Status (default: "Client review" if the option exists)
 * Returns the updated row.
 */
export async function sendTaskForClientApproval(
  cfg: BotConfig,
  pageId: string,
): Promise<TaskRow | null> {
  const schema = (await getDatabaseSchema(cfg)).properties;
  const clientApprovalProp =
    process.env.NOTION_PROP_CLIENT_APPROVAL?.trim() || "Client approval";
  const sentValue =
    process.env.NOTION_CLIENT_APPROVAL_SENT_VALUE?.trim() || "Sent";
  const targetStatus =
    process.env.NOTION_STATUS_CLIENT_REVIEW?.trim() || "Client review";

  const properties: Record<string, unknown> = {};

  const caSch = schema[clientApprovalProp];
  if (caSch) {
    if (caSch.type === "select") {
      properties[clientApprovalProp] = { select: { name: sentValue } };
    } else if (caSch.type === "status") {
      properties[clientApprovalProp] = { status: { name: sentValue } };
    } else if (caSch.type === "rich_text") {
      properties[clientApprovalProp] = {
        rich_text: [{ type: "text", text: { content: sentValue } }],
      };
    }
  }

  const statusSch = schema[cfg.notionProps.status];
  const statusOptionAvailable = (() => {
    if (!statusSch) return false;
    if (statusSch.type === "status") {
      return Boolean(
        statusSch.status?.options?.some((o) => o.name === targetStatus),
      );
    }
    if (statusSch.type === "select") {
      return Boolean(
        statusSch.select?.options?.some((o) => o.name === targetStatus),
      );
    }
    return false;
  })();
  if (statusSch && statusOptionAvailable) {
    if (statusSch.type === "status") {
      properties[cfg.notionProps.status] = { status: { name: targetStatus } };
    } else if (statusSch.type === "select") {
      properties[cfg.notionProps.status] = { select: { name: targetStatus } };
    }
  }

  if (Object.keys(properties).length === 0) {
    throw new Error(
      `No writable "${clientApprovalProp}" column found. Add it as Select with a "${sentValue}" option, or rename via NOTION_PROP_CLIENT_APPROVAL / NOTION_CLIENT_APPROVAL_SENT_VALUE.`,
    );
  }

  const client = new Client({ auth: cfg.notionToken });
  const updated = (await client.pages.update({
    page_id: pageId,
    properties: properties as never,
  })) as PageObjectResponse;
  return toTaskRow(updated, cfg);
}

// ── /new: quick task creation ───────────────────────────────────────────────

export type NewTaskInput = {
  title: string;
  client?: string;
  deliverable?: string;
  serviceLine?: string;
  priority?: string;
  status?: string;
  due?: string;
  shoot?: string;
  assignee?: string;
  telegramUserId?: number;
};

function richTextValue(v: string): Record<string, unknown> {
  return { rich_text: [{ type: "text", text: { content: v } }] };
}

function titleValue(v: string): Record<string, unknown> {
  return { title: [{ type: "text", text: { content: v } }] };
}

function selectWithFallback(
  sch: PropSchema,
  v: string,
): Record<string, unknown> | null {
  if (sch.type === "select") {
    const hit = sch.select?.options?.find(
      (o) => o.name.toLowerCase() === v.toLowerCase(),
    );
    return { select: { name: hit?.name ?? v } };
  }
  if (sch.type === "status") {
    const hit = sch.status?.options?.find(
      (o) => o.name.toLowerCase() === v.toLowerCase(),
    );
    if (!hit) return null;
    return { status: { name: hit.name } };
  }
  if (sch.type === "multi_select") {
    return { multi_select: [{ name: v }] };
  }
  if (sch.type === "rich_text") return richTextValue(v);
  if (sch.type === "title") return titleValue(v);
  return null;
}

function textOrTitle(sch: PropSchema, v: string): Record<string, unknown> | null {
  if (sch.type === "rich_text") return richTextValue(v);
  if (sch.type === "title") return titleValue(v);
  if (sch.type === "select") return { select: { name: v } };
  return null;
}

/**
 * Create a new Production task. Skips any field whose column doesn't exist
 * or can't be coerced; always sets the Name (title).
 */
export async function createProductionTask(
  cfg: BotConfig,
  input: NewTaskInput,
): Promise<TaskRow> {
  if (!input.title.trim()) {
    throw new Error("Title is required.");
  }

  const schema = (await getDatabaseSchema(cfg)).properties;
  const props = cfg.notionProps;
  const properties: Record<string, unknown> = {};

  const titleSch = schema[props.name];
  if (!titleSch || titleSch.type !== "title") {
    throw new Error(
      `No title column "${props.name}" on Production. Set NOTION_PROP_NAME.`,
    );
  }
  properties[props.name] = titleValue(input.title.trim());

  const assign = (name: string, val: Record<string, unknown> | null) => {
    if (val) properties[name] = val;
  };

  if (input.client) {
    const sch = schema[props.client];
    if (sch) assign(props.client, textOrTitle(sch, input.client));
  }
  if (input.deliverable) {
    const sch = schema[props.deliverable];
    if (sch) assign(props.deliverable, selectWithFallback(sch, input.deliverable));
  }
  if (input.serviceLine) {
    const sch = schema[props.serviceLine];
    if (sch) assign(props.serviceLine, selectWithFallback(sch, input.serviceLine));
  }
  if (input.priority) {
    const sch = schema[props.priority];
    if (sch) assign(props.priority, selectWithFallback(sch, input.priority));
  }
  if (input.status) {
    const sch = schema[props.status];
    if (sch) assign(props.status, selectWithFallback(sch, input.status));
  }
  if (input.due) {
    const sch = schema[props.due];
    if (sch?.type === "date") {
      properties[props.due] = { date: { start: input.due } };
    }
  }
  if (input.shoot) {
    const sch = schema[props.shoot];
    if (sch?.type === "date") {
      properties[props.shoot] = { date: { start: input.shoot } };
    }
  }
  if (input.assignee) {
    const sch = schema[props.assignee];
    if (sch) {
      if (sch.type === "rich_text") {
        properties[props.assignee] = richTextValue(input.assignee);
      } else if (sch.type === "title") {
        properties[props.assignee] = titleValue(input.assignee);
      } else if (sch.type === "select") {
        properties[props.assignee] = { select: { name: input.assignee } };
      }
    }
  }
  if (typeof input.telegramUserId === "number") {
    const sch = schema[props.telegramUserId];
    if (sch) {
      properties[props.telegramUserId] = telegramIdValueForSchema(
        sch,
        input.telegramUserId,
      );
    }
  }

  const client = new Client({ auth: cfg.notionToken });
  const page = (await client.pages.create({
    parent: { database_id: cfg.notionDatabaseId },
    properties: properties as never,
  })) as PageObjectResponse;
  return toTaskRow(page, cfg);
}
