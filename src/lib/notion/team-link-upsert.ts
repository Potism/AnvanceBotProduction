import { Client } from "@notionhq/client";
import type {
  DatabaseObjectResponse,
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import type { BotConfig } from "../types";
import { clearAssigneeMapCache } from "./assignee-map";
import { firstTitleOnPage, propertyAsString } from "./props";

type PropSchema = DatabaseObjectResponse["properties"][string];

function notionPropValue(
  schema: PropSchema,
  value: string | number,
): Record<string, unknown> {
  if (schema.type === "number") {
    const n =
      typeof value === "number" ? value : Number.parseFloat(String(value));
    if (!Number.isFinite(n)) {
      throw new Error("Telegram user id must be numeric for this column type.");
    }
    return { number: n };
  }
  if (schema.type === "rich_text") {
    return {
      rich_text: [{ type: "text", text: { content: String(value) } }],
    };
  }
  if (schema.type === "title") {
    return { title: [{ type: "text", text: { content: String(value) } }] };
  }
  throw new Error(
    `Unsupported column type "${schema.type}". Use Number, Title, or Rich text.`,
  );
}

function filterForTelegramId(
  propName: string,
  schema: PropSchema,
  telegramUserId: number,
): Record<string, unknown> {
  if (schema.type === "number") {
    return { property: propName, number: { equals: telegramUserId } };
  }
  if (schema.type === "rich_text") {
    return {
      property: propName,
      rich_text: { equals: String(telegramUserId) },
    };
  }
  if (schema.type === "title") {
    return { property: propName, title: { equals: String(telegramUserId) } };
  }
  throw new Error(
    `Unsupported Telegram column type "${schema.type}". Use Number, Rich text, or Title.`,
  );
}

/**
 * Create or update a row in the team link database for this Telegram user.
 * Clears the in-memory assignee map cache on success.
 */
export async function upsertTeamTelegramLink(
  cfg: BotConfig,
  telegramUserId: number,
  assigneeDisplay: string,
): Promise<void> {
  const dbId = process.env.NOTION_TEAM_LINK_DATABASE_ID?.trim();
  if (!dbId) {
    throw new Error("NOTION_TEAM_LINK_DATABASE_ID is not set");
  }

  const tgProp =
    process.env.NOTION_TEAM_LINK_TELEGRAM_PROP?.trim() || "Telegram user id";
  const assigneeProp =
    process.env.NOTION_TEAM_LINK_ASSIGNEE_PROP?.trim() || "Notion assignee";

  const client = new Client({ auth: cfg.notionToken });
  const db = (await client.databases.retrieve({
    database_id: dbId,
  })) as DatabaseObjectResponse;
  const schema = db.properties;
  const tgSch = schema[tgProp];
  const asgSch = schema[assigneeProp];
  const propList = Object.keys(schema).sort().join(", ");
  if (!tgSch) {
    throw new Error(
      `No property "${tgProp}". This database has: ${propList}. ` +
        `In Vercel set NOTION_TEAM_LINK_TELEGRAM_PROP to your Telegram id column name (exact match, case-sensitive).`,
    );
  }
  if (!asgSch) {
    throw new Error(
      `No property "${assigneeProp}". This database has: ${propList}. ` +
        `Set NOTION_TEAM_LINK_ASSIGNEE_PROP to your assignee/name column, or add that column.`,
    );
  }

  const filt = filterForTelegramId(tgProp, tgSch, telegramUserId);
  const existing = await client.databases.query({
    database_id: dbId,
    filter: filt as never,
    page_size: 5,
  });

  const tgVal = notionPropValue(tgSch, telegramUserId);
  const asgVal = notionPropValue(asgSch, assigneeDisplay);
  const props: Record<string, unknown> = {
    [tgProp]: tgVal,
    [assigneeProp]: asgVal,
  };

  const first = existing.results[0];
  if (first && "properties" in first) {
    await client.pages.update({
      page_id: first.id,
      properties: props as never,
    });
  } else {
    await client.pages.create({
      parent: { database_id: dbId },
      properties: props as never,
    });
  }

  clearAssigneeMapCache();
}

export type TeamLinkRowPreview = { telegram: string; assignee: string };

function teamLinkPropNames(): { dbId: string; tgProp: string; assigneeProp: string } {
  const dbId = process.env.NOTION_TEAM_LINK_DATABASE_ID?.trim() ?? "";
  const tgProp =
    process.env.NOTION_TEAM_LINK_TELEGRAM_PROP?.trim() || "Telegram user id";
  const assigneeProp =
    process.env.NOTION_TEAM_LINK_ASSIGNEE_PROP?.trim() || "Notion assignee";
  return { dbId, tgProp, assigneeProp };
}

function assigneeCell(page: PageObjectResponse, assigneeProp: string): string {
  return (
    propertyAsString(page, assigneeProp).trim() ||
    firstTitleOnPage(page).trim() ||
    "—"
  );
}

/** Recent rows in the team link database (for /ops team). */
export async function listTeamLinkRowPreviews(
  cfg: BotConfig,
  limit: number,
): Promise<TeamLinkRowPreview[]> {
  const { dbId, tgProp, assigneeProp } = teamLinkPropNames();
  if (!dbId) return [];
  const client = new Client({ auth: cfg.notionToken });
  const res = await client.databases.query({
    database_id: dbId,
    page_size: Math.min(100, Math.max(1, limit)),
  });
  const out: TeamLinkRowPreview[] = [];
  for (const r of res.results) {
    if (!("properties" in r)) continue;
    const page = r as PageObjectResponse;
    const tg = propertyAsString(page, tgProp).replace(/\s/g, "") || "—";
    out.push({ telegram: tg, assignee: assigneeCell(page, assigneeProp) });
  }
  return out;
}

/** Resolve assignee string for a Telegram id from the team link DB, if any. */
export async function findTeamLinkAssigneeForTg(
  cfg: BotConfig,
  telegramUserId: number,
): Promise<string | null> {
  const { dbId, tgProp, assigneeProp } = teamLinkPropNames();
  if (!dbId) return null;
  const client = new Client({ auth: cfg.notionToken });
  const db = (await client.databases.retrieve({
    database_id: dbId,
  })) as DatabaseObjectResponse;
  const schema = db.properties;
  const tgSch = schema[tgProp];
  if (!tgSch) return null;
  const filt = filterForTelegramId(tgProp, tgSch, telegramUserId);
  const existing = await client.databases.query({
    database_id: dbId,
    filter: filt as never,
    page_size: 3,
  });
  const first = existing.results[0];
  if (!first || !("properties" in first)) return null;
  const page = first as PageObjectResponse;
  const a = assigneeCell(page, assigneeProp);
  return a === "—" ? null : a;
}
