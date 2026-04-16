import { getBotConfig, isBotConfigured } from "../config";
import { resolveTelegramAssigneeMap } from "../notion/assignee-map";
import { fetchProductionTasks, type TaskView } from "../notion/tasks";
import {
  answerCallbackQuery,
  mainMenuKeyboard,
  sendMessageHtml,
} from "../telegram/client";
import {
  formatTaskBlocks,
  headerLine,
  splitTelegramHtml,
} from "../telegram/format";

type TelegramUser = { id: number; first_name?: string; username?: string };

function resolveAssigneeNeedle(
  telegramUserId: number,
  map: Record<string, string>,
): string | undefined {
  const direct = map[String(telegramUserId)];
  if (direct) return direct;
  return undefined;
}

function detectViewFromText(text: string): TaskView | null {
  const t = text.toLowerCase();
  if (
    t.includes("today") ||
    t.includes("this morning") ||
    t.includes("due today")
  )
    return "today";
  if (t.includes("week") || t.includes("next 7")) return "week";
  if (
    t.includes("my task") ||
    t.includes("my tasks") ||
    t.includes("what do i") ||
    t.includes("assign me") ||
    t.includes("queue")
  )
    return "mine";
  if (t.includes("team") || t.includes("board") || t.includes("everyone"))
    return "board";
  return null;
}

function viewTitle(view: TaskView): string {
  switch (view) {
    case "today":
      return "Today";
    case "week":
      return "This week";
    case "mine":
      return "My queue";
    case "board":
      return "Team board";
  }
}

export async function handleTelegramUpdate(update: unknown): Promise<void> {
  const cfgEarly = getBotConfig();
  if (!isBotConfigured()) {
    const token = cfgEarly.telegramBotToken;
    const u0 = update as {
      message?: { chat: { id: number } };
      callback_query?: { message?: { chat: { id: number } } };
    };
    const chatId =
      u0.message?.chat?.id ?? u0.callback_query?.message?.chat?.id;
    if (token && chatId) {
      await sendMessageHtml(
        token,
        chatId,
        "<b>Server not fully configured</b>\nSet <code>NOTION_TOKEN</code>, <code>NOTION_DATABASE_ID</code>, and <code>TELEGRAM_BOT_TOKEN</code> on Vercel (Production), then redeploy.",
        undefined,
      ).catch(() => {});
    } else {
      console.warn(
        "[telegram] Skipping update: missing NOTION_TOKEN, NOTION_DATABASE_ID, and/or TELEGRAM_BOT_TOKEN on server",
      );
    }
    return;
  }

  const cfg = getBotConfig();
  const assigneeMap = await resolveTelegramAssigneeMap(cfg);
  const token = cfg.telegramBotToken;
  const notionTeamDir = Boolean(
    process.env.NOTION_TEAM_LINK_DATABASE_ID?.trim(),
  );

  const u = update as {
    message?: { chat: { id: number }; text?: string; from?: TelegramUser };
    callback_query?: {
      id: string;
      from: TelegramUser;
      message?: { chat: { id: number }; message_id: number };
      data?: string;
    };
  };

  if (u.callback_query?.data && u.callback_query.message) {
    const chatId = u.callback_query.message.chat.id;
    const fromId = u.callback_query.from.id;
    const data = u.callback_query.data;

    if (data === "v:help") {
      await answerCallbackQuery(token, u.callback_query.id);
      await sendMessageHtml(
        token,
        chatId,
        helpMessage(fromId, assigneeMap),
        mainMenuKeyboard(),
      );
      return;
    }

    if (data.startsWith("v:")) {
      const view = data.slice(2) as TaskView;
      if (!["today", "week", "mine", "board"].includes(view)) return;
      await answerCallbackQuery(token, u.callback_query.id, "Pulling Notion…");
      const needle = resolveAssigneeNeedle(fromId, assigneeMap);
      if (view === "mine" && !needle) {
        await sendMessageHtml(
          token,
          chatId,
          mineWithoutMapMessage(fromId, notionTeamDir),
          mainMenuKeyboard(),
        );
        return;
      }
      try {
        const rows = await fetchProductionTasks(cfg, view, needle);
        const body = `${headerLine(viewTitle(view))}\n\n${formatTaskBlocks(rows)}`;
        for (const part of splitTelegramHtml(body)) {
          await sendMessageHtml(token, chatId, part, mainMenuKeyboard());
        }
      } catch {
        await sendMessageHtml(
          token,
          chatId,
          `<b>Notion error</b>\nCheck database id, integration access, and property names in env.`,
          mainMenuKeyboard(),
        );
      }
    }
    return;
  }

  const msg = u.message;
  if (!msg?.chat?.id) return;

  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  const text = (msg.text ?? "").trim();

  if (!fromId) return;

  if (text.startsWith("/start")) {
    await sendMessageHtml(
      token,
      chatId,
      welcomeMessage(fromId, assigneeMap, notionTeamDir),
      mainMenuKeyboard(),
    );
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessageHtml(
      token,
      chatId,
      helpMessage(fromId, assigneeMap),
      mainMenuKeyboard(),
    );
    return;
  }

  const cmdView =
    text.startsWith("/today")
      ? ("today" as const)
      : text.startsWith("/week")
        ? ("week" as const)
        : text.startsWith("/mine")
          ? ("mine" as const)
          : text.startsWith("/board")
            ? ("board" as const)
            : null;

  const nlView = cmdView ?? detectViewFromText(text);

  if (nlView) {
    const needle = resolveAssigneeNeedle(fromId, assigneeMap);
    if (nlView === "mine" && !needle) {
      await sendMessageHtml(
        token,
        chatId,
        mineWithoutMapMessage(fromId, notionTeamDir),
        mainMenuKeyboard(),
      );
      return;
    }
    try {
      const rows = await fetchProductionTasks(cfg, nlView, needle);
      const body = `${headerLine(viewTitle(nlView))}\n\n${formatTaskBlocks(rows)}`;
      for (const part of splitTelegramHtml(body)) {
        await sendMessageHtml(token, chatId, part, mainMenuKeyboard());
      }
    } catch {
      await sendMessageHtml(
        token,
        chatId,
        `<b>Notion error</b>\nCheck database id, integration access, and property names in env.`,
        mainMenuKeyboard(),
      );
    }
    return;
  }

  await sendMessageHtml(
    token,
    chatId,
    `Try: <b>What are my tasks today?</b>\nOr tap a button below.`,
    mainMenuKeyboard(),
  );
}

function welcomeMessage(
  telegramUserId: number,
  map: Record<string, string>,
  notionTeamDir: boolean,
): string {
  const linked = Boolean(map[String(telegramUserId)]);
  const linkHint = linked
    ? "You are linked to a Notion assignee name."
    : notionTeamDir
      ? `<b>Heads up:</b> add a row in your Notion <b>team link</b> database (Telegram id → assignee name), or use <code>TELEGRAM_USER_ASSIGNEE_MAP</code> in Vercel for overrides.`
      : `<b>Heads up:</b> add your Telegram user id to <code>TELEGRAM_USER_ASSIGNEE_MAP</code> or configure <code>NOTION_TEAM_LINK_DATABASE_ID</code> (see <code>.env.example</code>) so “My queue” filters to you.`;
  return `<b>Anvance Production</b> · Ops copilot\n\n${linkHint}\n\nTap a view or ask in plain language.`;
}

function mineWithoutMapMessage(
  telegramUserId: number,
  notionTeamDir: boolean,
): string {
  const tgCol =
    process.env.NOTION_TEAM_LINK_TELEGRAM_PROP?.trim() || "Telegram user id";
  const assigneeCol =
    process.env.NOTION_TEAM_LINK_ASSIGNEE_PROP?.trim() || "Notion assignee";
  const notionLine = notionTeamDir
    ? `\n\n<b>Team link database is configured</b>, but no row matches your Telegram id <code>${telegramUserId}</code>.\n\n<b>Checklist</b>\n• Row exists with <code>${tgCol}</code> = <code>${telegramUserId}</code> (digits only)\n• <code>${assigneeCol}</code> <i>or the page title</i> = exact Production <b>Assignee</b> text (e.g. from your export)\n• Property names in Notion match the defaults above, or set <code>NOTION_TEAM_LINK_TELEGRAM_PROP</code> / <code>NOTION_TEAM_LINK_ASSIGNEE_PROP</code> in Vercel to your real column names\n• Integration is connected to the team link database\n• Redeploy after env changes; wait ~1 min (cache) or send another message`
    : "";
  return `<b>My queue</b> needs an assignee link.${notionLine}\n\n<b>Or</b> add to <code>TELEGRAM_USER_ASSIGNEE_MAP</code> in Vercel (JSON):\n<code>{"${telegramUserId}":"Your Name In Notion"}</code>\n\nUse the exact name shown in the Production <b>Assignee</b> column.`;
}

function helpMessage(
  telegramUserId: number,
  map: Record<string, string>,
): string {
  const idLine = `Your Telegram user id: <code>${telegramUserId}</code>`;
  const mapLine =
    Object.keys(map).length === 0
      ? "No assignee links loaded (Notion team DB + env map empty)."
      : `Assignee links loaded (${Object.keys(map).length} entries).`;
  return `${idLine}\n${mapLine}\n\n<b>Commands</b>\n/start — menu\n/help — this message\n/today /week /mine /board\n\n<b>Natural language</b>\n“what are my tasks today”, “this week”, “team board”`;
}
