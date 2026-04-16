import { Client } from "@notionhq/client";
import type { DatabaseObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import type { BotConfig } from "../types";
import { clearAssigneeMapCache } from "./assignee-map";

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
  if (!tgSch) {
    throw new Error(`Team link database has no property named "${tgProp}".`);
  }
  if (!asgSch) {
    throw new Error(`Team link database has no property named "${assigneeProp}".`);
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
