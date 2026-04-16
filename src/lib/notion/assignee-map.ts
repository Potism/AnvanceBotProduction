import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import type { BotConfig } from "../types";
import { propertyAsString } from "./props";

const TTL_MS = 60_000;

type CacheEntry = { at: number; map: Record<string, string>; key: string };
let cache: CacheEntry | null = null;

function cacheKey(cfg: BotConfig): string {
  const db = process.env.NOTION_TEAM_LINK_DATABASE_ID?.trim() ?? "";
  const envRaw = process.env.TELEGRAM_USER_ASSIGNEE_MAP ?? "";
  return `${db}|${envRaw}`;
}

/**
 * Telegram user id → string matched against Notion Assignee (substring match).
 * Loads optional Notion "team link" database, then merges env TELEGRAM_USER_ASSIGNEE_MAP
 * (env entries override same Telegram id for local overrides).
 */
export async function resolveTelegramAssigneeMap(
  cfg: BotConfig,
): Promise<Record<string, string>> {
  const key = cacheKey(cfg);
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) {
    return cache.map;
  }

  let fromNotion: Record<string, string> = {};
  const notionDb = process.env.NOTION_TEAM_LINK_DATABASE_ID?.trim();
  if (notionDb) {
    try {
      fromNotion = await fetchAssigneeLinksFromNotion(cfg, notionDb);
    } catch (e) {
      console.error("[assignee-map] Notion team directory query failed", e);
    }
  }

  const merged = { ...fromNotion, ...cfg.telegramUserAssignees };
  cache = { at: Date.now(), map: merged, key };
  return merged;
}

async function fetchAssigneeLinksFromNotion(
  cfg: BotConfig,
  databaseId: string,
): Promise<Record<string, string>> {
  const tgProp =
    process.env.NOTION_TEAM_LINK_TELEGRAM_PROP?.trim() || "Telegram user id";
  const assigneeProp =
    process.env.NOTION_TEAM_LINK_ASSIGNEE_PROP?.trim() || "Notion assignee";

  const client = new Client({ auth: cfg.notionToken });
  const out: Record<string, string> = {};
  let cursor: string | undefined;

  do {
    const res = await client.databases.query({
      database_id: databaseId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const r of res.results) {
      if (!("properties" in r)) continue;
      const page = r as PageObjectResponse;
      const rawTg = propertyAsString(page, tgProp).replace(/\s/g, "");
      const assignee = propertyAsString(page, assigneeProp).trim();
      if (!/^\d+$/.test(rawTg) || !assignee) continue;
      out[rawTg] = assignee;
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);

  return out;
}
