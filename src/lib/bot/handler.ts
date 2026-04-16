import { getBotConfig, isBotConfigured } from "../config";
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
  if (!isBotConfigured()) return;

  const cfg = getBotConfig();
  const token = cfg.telegramBotToken;

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
        helpMessage(fromId, cfg.telegramUserAssignees),
        mainMenuKeyboard(),
      );
      return;
    }

    if (data.startsWith("v:")) {
      const view = data.slice(2) as TaskView;
      if (!["today", "week", "mine", "board"].includes(view)) return;
      await answerCallbackQuery(token, u.callback_query.id, "Pulling Notion…");
      const needle = resolveAssigneeNeedle(fromId, cfg.telegramUserAssignees);
      if (view === "mine" && !needle) {
        await sendMessageHtml(
          token,
          chatId,
          mineWithoutMapMessage(fromId),
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
      welcomeMessage(fromId, cfg.telegramUserAssignees),
      mainMenuKeyboard(),
    );
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessageHtml(
      token,
      chatId,
      helpMessage(fromId, cfg.telegramUserAssignees),
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
    const needle = resolveAssigneeNeedle(fromId, cfg.telegramUserAssignees);
    if (nlView === "mine" && !needle) {
      await sendMessageHtml(
        token,
        chatId,
        mineWithoutMapMessage(fromId),
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
): string {
  const linked = Boolean(map[String(telegramUserId)]);
  const linkHint = linked
    ? "You are linked to a Notion assignee name."
    : `<b>Heads up:</b> add your Telegram user id to <code>TELEGRAM_USER_ASSIGNEE_MAP</code> so “My queue” filters to you.`;
  return `<b>Anvance Production</b> · Ops copilot\n\n${linkHint}\n\nTap a view or ask in plain language.`;
}

function mineWithoutMapMessage(telegramUserId: number): string {
  return `<b>My queue</b> needs an assignee link.\n\nAdd this to <code>TELEGRAM_USER_ASSIGNEE_MAP</code> on the server (JSON):\n<code>{"${telegramUserId}":"Your Name In Notion"}</code>\n\nUse the exact name shown in the Notion <b>Assignee</b> column.`;
}

function helpMessage(
  telegramUserId: number,
  map: Record<string, string>,
): string {
  const idLine = `Your Telegram user id: <code>${telegramUserId}</code>`;
  const mapLine =
    Object.keys(map).length === 0
      ? "No assignee map configured yet."
      : "Assignee map is configured on the server.";
  return `${idLine}\n${mapLine}\n\n<b>Commands</b>\n/start — menu\n/help — this message\n/today /week /mine /board\n\n<b>Natural language</b>\n“what are my tasks today”, “this week”, “team board”`;
}
