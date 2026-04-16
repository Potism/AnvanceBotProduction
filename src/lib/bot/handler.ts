import { getBotConfig, isBotConfigured } from "../config";
import { resolveTelegramAssigneeMap } from "../notion/assignee-map";
import {
  loadAssigneeLinkCatalog,
  matchAssigneeInput,
} from "../notion/production-assignees";
import { upsertTeamTelegramLink } from "../notion/team-link-upsert";
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
import type { AssigneeMatchResult } from "../notion/production-assignees";
import type { BotConfig } from "../types";

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

    if (data === "a:link") {
      await answerCallbackQuery(token, u.callback_query.id);
      await sendMessageHtml(
        token,
        chatId,
        linkInstructionsHtml(),
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

  const linkMatch = text.match(/^\/link(?:@\S*)?(?:\s+([\s\S]*))?$/i);
  if (linkMatch) {
    const nameArg = (linkMatch[1] ?? "").trim();
    await handleLinkCommand(
      cfg,
      token,
      chatId,
      fromId,
      nameArg,
      notionTeamDir,
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
    `Try <i>tasks due today</i> or tap a view below.\nNeed <b>My queue</b>? Use <code>/link</code> or <b>Link account</b>.`,
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
    ? "You are set up for <b>My queue</b>."
    : notionTeamDir
      ? `Tap <b>Link account</b> or <code>/link</code> with your <b>Assignee</b> name or workspace <b>email</b> (see /help).`
      : `For <b>My queue</b>, ops can enable the team link database or add you via <code>TELEGRAM_USER_ASSIGNEE_MAP</code> in Vercel.`;
  return `<b>Anvance Production</b>\n<i>Notion task desk</i>\n\n${linkHint}\n\nUse the keyboard or type naturally — e.g. <i>tasks due today</i>.`;
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
    ? `\n\n<b>Self-service:</b> <code>/link Your full Notion assignee name</code> (same as Production).\n\n<b>Or</b> ask ops to add a row: <code>${tgCol}</code> = <code>${telegramUserId}</code>, <code>${assigneeCol}</code> or page title = assignee name. Wait ~1 min after changes (cache).`
    : "";
  return `<b>My queue</b> needs an assignee link.${notionLine}\n\n<b>Ops-only fallback</b> — <code>TELEGRAM_USER_ASSIGNEE_MAP</code> in Vercel:\n<code>{"${telegramUserId}":"Your Name In Notion"}</code>`;
}

function helpMessage(
  telegramUserId: number,
  map: Record<string, string>,
): string {
  const idLine = `Your Telegram user id: <code>${telegramUserId}</code>`;
  const mapLine =
    Object.keys(map).length === 0
      ? "No assignee links loaded yet."
      : `Assignee links on file: <b>${Object.keys(map).length}</b>`;
  return `${idLine}\n${mapLine}\n\n<b>Shortcuts</b>\n<code>/today</code> · <code>/week</code> · <code>/mine</code> · <code>/board</code>\n<code>/link</code> — connect Telegram ↔ Notion assignee\n<code>/start</code> · <code>/help</code>\n\n<b>Natural language</b>\n<i>What are my tasks today?</i> · <i>this week</i> · <i>team board</i>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function linkInstructionsHtml(): string {
  return `<b>Link your Telegram account</b>

For <b>My queue</b>, send either:

• <b>Name</b> — as shown on tasks (text assignee, or each person’s name when Assignee is <b>People</b>)
• <b>Work email</b> — same email Notion has for you in the workspace (if the integration can read it)

<code>/link Albert Rhey Embalsado</code>
<code>/link you@company.com</code>

We match open Production tasks. If several names match, use a fuller name.`;
}

function linkDisabledNoDbHtml(): string {
  return `<b>Self-service link is off</b>

Ask ops to set <code>NOTION_TEAM_LINK_DATABASE_ID</code> in Vercel (team directory database shared with the integration), redeploy, then try <code>/link</code> again.`;
}

function linkNoAssigneesInProductionHtml(): string {
  return `<b>No assignee names found</b> on open tasks in Production.

Add at least one task with an <b>Assignee</b>, then try <code>/link</code> again.`;
}

function linkMatchFailedHtml(raw: string, match: AssigneeMatchResult): string {
  if (!match.ok && match.reason === "empty") return linkInstructionsHtml();
  const name = esc(raw);
  if (!match.ok && match.reason === "ambiguous") {
    const lines = match.suggestions
      .map((s) => `• <code>${esc(s)}</code>`)
      .join("\n");
    return `<b>Several assignees matched</b> “${name}”.

Send a fuller name, e.g.:
<code>/link ${esc(match.suggestions[0])}</code>

<b>Possible matches</b>
${lines}`;
  }
  if (!match.ok && match.reason === "none") {
    const sample = match.suggestions.slice(0, 10);
    const lines = sample.map((s) => `• <code>${esc(s)}</code>`).join("\n");
    return `<b>No assignee matched</b> “${name}”.

Use the exact text from Production <b>Assignee</b>. Examples on file:
${lines}`;
  }
  return linkInstructionsHtml();
}

function linkSuccessHtml(
  assignee: string,
  mode: "exact" | "unique_partial" | "email",
): string {
  const note =
    mode === "unique_partial"
      ? "\n<i>Matched from a partial name — you can re-link with the full name anytime.</i>"
      : mode === "email"
        ? "\n<i>Matched by workspace email from Notion.</i>"
        : "";
  return `<b>Linked</b>

Your Telegram is mapped to:
<code>${esc(assignee)}</code>

Open <b>My queue</b> when you are ready.${note}`;
}

function linkErrorHtml(message: string): string {
  return `<b>Could not save link</b>\n\n<code>${esc(message)}</code>\n\nIf the team link database has extra <i>required</i> columns, add defaults or make them optional in Notion.`;
}

async function handleLinkCommand(
  cfg: BotConfig,
  token: string,
  chatId: number,
  fromId: number,
  nameArg: string,
  notionTeamDir: boolean,
): Promise<void> {
  if (!notionTeamDir) {
    await sendMessageHtml(
      token,
      chatId,
      linkDisabledNoDbHtml(),
      mainMenuKeyboard(),
    );
    return;
  }
  if (!nameArg) {
    await sendMessageHtml(
      token,
      chatId,
      linkInstructionsHtml(),
      mainMenuKeyboard(),
    );
    return;
  }
  try {
    const catalog = await loadAssigneeLinkCatalog(cfg);
    if (catalog.displayNames.length === 0) {
      await sendMessageHtml(
        token,
        chatId,
        linkNoAssigneesInProductionHtml(),
        mainMenuKeyboard(),
      );
      return;
    }
    const match = matchAssigneeInput(nameArg, catalog);
    if (!match.ok) {
      await sendMessageHtml(
        token,
        chatId,
        linkMatchFailedHtml(nameArg, match),
        mainMenuKeyboard(),
      );
      return;
    }
    await upsertTeamTelegramLink(cfg, fromId, match.assignee);
    await sendMessageHtml(
      token,
      chatId,
      linkSuccessHtml(match.assignee, match.mode),
      mainMenuKeyboard(),
    );
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : "Unknown error while saving link.";
    console.error("[link]", e);
    await sendMessageHtml(
      token,
      chatId,
      linkErrorHtml(msg),
      mainMenuKeyboard(),
    );
  }
}
