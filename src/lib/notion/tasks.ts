import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import {
  pageShareUrl,
  pageTitle,
  propertyAsString,
  propertyAsTelegramId,
} from "./props";
import type { BotConfig } from "../types";

function startOfDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysISO(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T12:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseISODate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export type TaskView = "today" | "week" | "mine" | "board" | "overdue";

export type TaskRow = {
  id: string;
  url: string;
  title: string;
  assignee: string;
  telegramUserId: number | null;
  due: string;
  shoot: string;
  status: string;
  priority: string;
  deliverable: string;
  client: string;
  serviceLine: string;
  reviewer: string;
};

/** Statuses we treat as closed (hidden from My queue, digest, overdue). */
export const DONE_STATUSES = new Set<string>(
  ["done", "approved", "shipped", "cancelled", "canceled", "scheduled", "archived"].map(
    (s) => s.toLowerCase(),
  ),
);

export function isTaskDone(status: string): boolean {
  return DONE_STATUSES.has(status.trim().toLowerCase());
}

export function toTaskRow(page: PageObjectResponse, cfg: BotConfig): TaskRow {
  const props = cfg.notionProps;
  return {
    id: page.id,
    url: pageShareUrl(page),
    title: pageTitle(page, props.name) || "Untitled",
    assignee: propertyAsString(page, props.assignee),
    telegramUserId: propertyAsTelegramId(page, props.telegramUserId),
    due: propertyAsString(page, props.due),
    shoot: propertyAsString(page, props.shoot),
    status: propertyAsString(page, props.status),
    priority: propertyAsString(page, props.priority),
    deliverable: propertyAsString(page, props.deliverable),
    client: propertyAsString(page, props.client),
    serviceLine: propertyAsString(page, props.serviceLine),
    reviewer: propertyAsString(page, props.reviewer),
  };
}

function matchesAssignee(row: TaskRow, needle: string | undefined): boolean {
  if (!needle?.trim()) return true;
  const h = needle.trim().toLowerCase();
  const hay = row.assignee.toLowerCase();
  if (!hay) return false;
  return hay.includes(h) || h.includes(hay);
}

/** Raw pages from Production for a view (before row-level filters). */
export async function fetchProductionPages(
  cfg: BotConfig,
  view: TaskView,
): Promise<PageObjectResponse[]> {
  const client = new Client({ auth: cfg.notionToken });
  const today = startOfDay(new Date());
  const weekEnd = addDaysISO(today, 7);
  const props = cfg.notionProps;

  const responses: PageObjectResponse[] = [];
  let cursor: string | undefined;

  do {
    const body: Parameters<typeof client.databases.query>[0] = {
      database_id: cfg.notionDatabaseId,
      page_size: 100,
      start_cursor: cursor,
    };

    if (view === "today") {
      body.filter = {
        or: [
          { property: props.due, date: { equals: today } },
          { property: props.shoot, date: { equals: today } },
        ],
      };
    } else if (view === "week") {
      body.filter = {
        or: [
          {
            and: [
              { property: props.due, date: { on_or_after: today } },
              { property: props.due, date: { on_or_before: weekEnd } },
            ],
          },
          {
            and: [
              { property: props.shoot, date: { on_or_after: today } },
              { property: props.shoot, date: { on_or_before: weekEnd } },
            ],
          },
        ],
      };
    } else if (view === "overdue") {
      body.filter = {
        property: props.due,
        date: { before: today },
      };
    }

    const res = await client.databases.query(body);
    for (const r of res.results) {
      if ("properties" in r) responses.push(r as PageObjectResponse);
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);

  return responses;
}

export async function fetchProductionTasks(
  cfg: BotConfig,
  view: TaskView,
  assigneeNeedle: string | undefined,
  telegramUserId?: number,
): Promise<TaskRow[]> {
  const responses = await fetchProductionPages(cfg, view);

  let rows = responses.map((p) => toTaskRow(p, cfg));

  if (view === "today" || view === "week") {
    rows = rows.filter((row) => {
      if (telegramUserId && row.telegramUserId === telegramUserId) return true;
      return matchesAssignee(row, assigneeNeedle);
    });
  } else if (view === "mine") {
    rows = rows.filter((row) => {
      const tgMatch = telegramUserId && row.telegramUserId === telegramUserId;
      const nameMatch = matchesAssignee(row, assigneeNeedle);
      return Boolean(tgMatch) || (!telegramUserId && nameMatch);
    });
    rows = rows.filter((row) => !isTaskDone(row.status));
  } else if (view === "overdue") {
    rows = rows.filter((row) => !isTaskDone(row.status));
    if (telegramUserId) {
      rows = rows.filter(
        (row) =>
          row.telegramUserId === telegramUserId ||
          matchesAssignee(row, assigneeNeedle),
      );
    }
  }

  rows.sort((a, b) => {
    const da = parseISODate(a.due) ?? parseISODate(a.shoot) ?? "";
    const db = parseISODate(b.due) ?? parseISODate(b.shoot) ?? "";
    if (da && db) return da.localeCompare(db);
    if (da) return -1;
    if (db) return 1;
    return a.title.localeCompare(b.title);
  });

  return rows;
}

/** Full-text-ish search over open tasks in Production. */
export async function searchProductionTasks(
  cfg: BotConfig,
  query: string,
  limit = 10,
): Promise<TaskRow[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const pages = await fetchProductionPages(cfg, "board");
  const rows = pages.map((p) => toTaskRow(p, cfg));
  const scored = rows
    .map((r) => {
      const hay = [
        r.title,
        r.client,
        r.deliverable,
        r.assignee,
        r.status,
        r.serviceLine,
        r.priority,
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      if (r.title.toLowerCase().includes(q)) score += 3;
      if (hay.includes(q)) score += 1;
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);
  return scored;
}

/** Retrieve a single page as a TaskRow (for action callbacks and notifications). */
export async function fetchTaskById(
  cfg: BotConfig,
  pageId: string,
): Promise<TaskRow | null> {
  try {
    const client = new Client({ auth: cfg.notionToken });
    const page = (await client.pages.retrieve({
      page_id: pageId,
    })) as PageObjectResponse;
    return toTaskRow(page, cfg);
  } catch {
    return null;
  }
}
