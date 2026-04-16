import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import { pageTitle, propertyAsString } from "./props";
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

export type TaskView = "today" | "week" | "mine" | "board";

export type TaskRow = {
  id: string;
  title: string;
  assignee: string;
  due: string;
  shoot: string;
  status: string;
  priority: string;
  deliverable: string;
  client: string;
  serviceLine: string;
};

function toRow(page: PageObjectResponse, cfg: BotConfig): TaskRow {
  const props = cfg.notionProps;
  return {
    id: page.id,
    title: pageTitle(page, props.name),
    assignee: propertyAsString(page, props.assignee),
    due: propertyAsString(page, props.due),
    shoot: propertyAsString(page, props.shoot),
    status: propertyAsString(page, props.status),
    priority: propertyAsString(page, props.priority),
    deliverable: propertyAsString(page, props.deliverable),
    client: propertyAsString(page, props.client),
    serviceLine: propertyAsString(page, props.serviceLine),
  };
}

function matchesAssignee(row: TaskRow, needle: string | undefined): boolean {
  if (!needle?.trim()) return true;
  const h = needle.trim().toLowerCase();
  const hay = row.assignee.toLowerCase();
  if (!hay) return false;
  return hay.includes(h) || h.includes(hay);
}

/** Raw pages from Production for a view (before assignee / status filters on rows). */
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
          {
            property: props.due,
            date: { equals: today },
          },
          {
            property: props.shoot,
            date: { equals: today },
          },
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
): Promise<TaskRow[]> {
  const responses = await fetchProductionPages(cfg, view);

  let rows = responses.map((p) => toRow(p, cfg));

  if (view === "today" || view === "week") {
    rows = rows.filter((row) => matchesAssignee(row, assigneeNeedle));
  } else if (view === "mine") {
    rows = rows.filter((row) => matchesAssignee(row, assigneeNeedle));
    const statusDone = new Set(
      ["done", "approved", "shipped", "cancelled", "canceled"].map((s) =>
        s.toLowerCase(),
      ),
    );
    rows = rows.filter((row) => !statusDone.has(row.status.toLowerCase()));
  }

  if (view === "today" || view === "week") {
    rows.sort((a, b) => {
      const da = parseISODate(a.due) ?? parseISODate(a.shoot) ?? "";
      const db = parseISODate(b.due) ?? parseISODate(b.shoot) ?? "";
      return da.localeCompare(db);
    });
  } else {
    rows.sort((a, b) => {
      const da = parseISODate(a.due) ?? "";
      const db = parseISODate(b.due) ?? "";
      return da.localeCompare(db);
    });
  }

  return rows;
}
