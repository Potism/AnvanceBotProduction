function parseUserAssigneeMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function getBotConfig() {
  const notionToken = process.env.NOTION_TOKEN ?? "";
  const notionDatabaseId = process.env.NOTION_DATABASE_ID ?? "";
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const publicAppUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  return {
    notionToken,
    notionDatabaseId,
    telegramBotToken,
    telegramWebhookSecret,
    publicAppUrl,
    notionProps: {
      name: process.env.NOTION_PROP_NAME ?? "Name",
      assignee: process.env.NOTION_PROP_ASSIGNEE ?? "Assignee",
      due: process.env.NOTION_PROP_DUE ?? "Due date",
      shoot: process.env.NOTION_PROP_SHOOT ?? "Shoot / live date",
      status: process.env.NOTION_PROP_STATUS ?? "Status",
      priority: process.env.NOTION_PROP_PRIORITY ?? "Priority",
      deliverable: process.env.NOTION_PROP_DELIVERABLE ?? "Deliverable",
      client: process.env.NOTION_PROP_CLIENT ?? "Client",
      serviceLine: process.env.NOTION_PROP_SERVICE_LINE ?? "Service line",
      telegramUserId:
        process.env.NOTION_PROP_TELEGRAM_USER_ID ?? "Telegram user id",
      reviewer: process.env.NOTION_PROP_REVIEWER ?? "Reviewer",
    },
    telegramUserAssignees: parseUserAssigneeMap(process.env.TELEGRAM_USER_ASSIGNEE_MAP),
  };
}

export function isBotConfigured(): boolean {
  const c = getBotConfig();
  return Boolean(c.notionToken && c.notionDatabaseId && c.telegramBotToken);
}
