import { getBotConfig, isBotConfigured } from "../config";
import { resolveTelegramAssigneeMap } from "../notion/assignee-map";
import {
  createProductionTask,
  findAssigneeForTelegramId,
  sendTaskForClientApproval,
  stampTelegramIdOnProductionForAssignee,
  snoozeTaskDue,
  updateTaskStatus,
} from "../notion/actions";
import { parseNewTaskArgs } from "./new-task-parse";
import {
  aiEnabled,
  extractNewTask,
  routeIntent,
  transcribeAudio,
  type ExtractedTask,
  type ExtractionContext,
} from "../ai/openai";
import { downloadTelegramFile } from "../ai/telegram-voice";
import {
  loadAssigneeLinkCatalog,
  matchAssigneeInput,
} from "../notion/production-assignees";
import { fetchStatusOptionNames } from "../notion/actions";
import {
  fetchProductionTasks,
  fetchTaskById,
  searchProductionTasks,
  type TaskRow,
  type TaskView,
} from "../notion/tasks";
import { upsertTeamTelegramLink } from "../notion/team-link-upsert";
import { tryHandleOpsCommand } from "./ops-commands";
import {
  cancelWizard,
  handleWizardCallback,
  handleWizardText,
  hasActiveWizard,
  startWizard,
} from "./wizard";
import {
  actionAckText,
  dmSocialManagers,
  parseSocialManagerIds,
} from "./notify";
import {
  answerCallbackQuery,
  editMessageTextHtml,
  mainMenuKeyboard,
  sendMessageHtml,
  taskActionKeyboard,
} from "../telegram/client";
import {
  formatTaskCard,
  formatTaskBlocks,
  headerLine,
  splitTelegramHtml,
} from "../telegram/format";
import type { AssigneeMatchResult } from "../notion/production-assignees";
import type { BotConfig } from "../types";

type TelegramUser = { id: number; first_name?: string; username?: string };

function detectViewFromText(text: string): TaskView | null {
  const t = text.toLowerCase();
  if (t.includes("overdue") || t.includes("late")) return "overdue";
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
    case "overdue":
      return "Overdue";
  }
}

function restorePageId(short: string): string {
  const s = short.replace(/-/g, "");
  if (s.length !== 32) return short;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

async function sendView(
  cfg: BotConfig,
  chatId: number,
  view: TaskView,
  telegramUserId: number,
  assigneeNeedle: string | undefined,
): Promise<void> {
  const token = cfg.telegramBotToken;
  try {
    const rows = await fetchProductionTasks(
      cfg,
      view,
      assigneeNeedle,
      telegramUserId,
    );
    if (rows.length === 0) {
      await sendMessageHtml(
        token,
        chatId,
        `${headerLine(viewTitle(view))}\n\n<i>Nothing here. Enjoy the quiet.</i>`,
        mainMenuKeyboard(),
      );
      return;
    }

    const isPersonal = view === "mine" || view === "overdue";
    if (isPersonal && rows.length <= 12) {
      await sendMessageHtml(
        token,
        chatId,
        `${headerLine(viewTitle(view))} · <i>${rows.length} task${rows.length === 1 ? "" : "s"}</i>`,
        mainMenuKeyboard(),
      );
      for (const r of rows) {
        await sendMessageHtml(
          token,
          chatId,
          formatTaskCard(r),
          taskActionKeyboard(r.id, r.url),
        );
      }
      return;
    }

    const body = `${headerLine(viewTitle(view))}\n\n${formatTaskBlocks(rows)}`;
    for (const part of splitTelegramHtml(body)) {
      await sendMessageHtml(token, chatId, part, mainMenuKeyboard());
    }
  } catch (e) {
    console.error("[view]", view, e);
    await sendMessageHtml(
      token,
      chatId,
      `<b>Notion error</b>\nCheck database id, integration access, and property names in env.`,
      mainMenuKeyboard(),
    );
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
    message?: {
      chat: { id: number };
      text?: string;
      caption?: string;
      from?: TelegramUser;
      voice?: { file_id: string; duration?: number };
      audio?: { file_id: string; duration?: number };
      video_note?: { file_id: string; duration?: number };
    };
    callback_query?: {
      id: string;
      from: TelegramUser;
      message?: { chat: { id: number }; message_id: number };
      data?: string;
    };
  };

  if (u.callback_query?.data && u.callback_query.message) {
    const chatId = u.callback_query.message.chat.id;
    const messageId = u.callback_query.message.message_id;
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

    if (data === "a:find") {
      await answerCallbackQuery(token, u.callback_query.id);
      await sendMessageHtml(
        token,
        chatId,
        `<b>Find a task</b>\n\nType <code>/find &lt;keyword&gt;</code>\n\nExamples:\n<code>/find hotel</code>\n<code>/find APX reel</code>\n<code>/find changes</code>`,
        mainMenuKeyboard(),
      );
      return;
    }

    if (data.startsWith("n:")) {
      await handleWizardCallback(
        cfg,
        fromId,
        chatId,
        messageId,
        u.callback_query.id,
        data,
      );
      return;
    }

    if (data.startsWith("t:")) {
      await handleTaskActionCallback(
        cfg,
        token,
        chatId,
        messageId,
        u.callback_query.id,
        fromId,
        data,
      );
      return;
    }

    if (data.startsWith("v:")) {
      const view = data.slice(2) as TaskView;
      if (!["today", "week", "mine", "board", "overdue"].includes(view)) return;
      await answerCallbackQuery(token, u.callback_query.id, "Pulling Notion…");
      const needle = assigneeMap[String(fromId)];
      await sendView(cfg, chatId, view, fromId, needle);
    }
    return;
  }

  const msg = u.message;
  if (!msg?.chat?.id) return;

  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  let text = (msg.text ?? msg.caption ?? "").trim();

  if (!fromId) return;

  const voiceFile =
    msg.voice?.file_id ??
    msg.audio?.file_id ??
    msg.video_note?.file_id ??
    null;
  if (voiceFile) {
    const spoken = await handleVoiceMessage(token, chatId, voiceFile);
    if (!spoken) return;
    text = spoken;
  }

  if (hasActiveWizard(fromId) && !text.startsWith("/")) {
    const consumed = await handleWizardText(cfg, fromId, text);
    if (consumed) return;
  }

  if (text.startsWith("/cancel")) {
    const had = cancelWizard(fromId);
    await sendMessageHtml(
      token,
      chatId,
      had ? "<i>New task cancelled.</i>" : "<i>Nothing to cancel.</i>",
      mainMenuKeyboard(),
    );
    return;
  }

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
    await handleLinkCommand(cfg, token, chatId, fromId, nameArg, notionTeamDir);
    return;
  }

  const findMatch = text.match(/^\/find(?:@\S*)?(?:\s+([\s\S]*))?$/i);
  if (findMatch) {
    const q = (findMatch[1] ?? "").trim();
    await handleFindCommand(cfg, chatId, q);
    return;
  }

  const newMatch = text.match(/^\/new(?:@\S*)?(?:\s+([\s\S]*))?$/i);
  if (newMatch) {
    const args = (newMatch[1] ?? "").trim();
    if (!args) {
      await startWizard(cfg, chatId, fromId);
      return;
    }
    await handleNewCommand(cfg, chatId, fromId, args);
    return;
  }

  if (await tryHandleOpsCommand(cfg, token, chatId, fromId, text)) {
    return;
  }

  const cmdView =
    text.startsWith("/today")
      ? ("today" as const)
      : text.startsWith("/week")
        ? ("week" as const)
        : text.startsWith("/mine")
          ? ("mine" as const)
          : text.startsWith("/overdue")
            ? ("overdue" as const)
            : text.startsWith("/board")
              ? ("board" as const)
              : null;

  const nlView = cmdView ?? detectViewFromText(text);

  if (nlView) {
    const needle = assigneeMap[String(fromId)];
    await sendView(cfg, chatId, nlView, fromId, needle);
    return;
  }

  if (aiEnabled() && text) {
    try {
      const intent = await routeIntent(text);
      if (intent.kind === "view") {
        const needle = assigneeMap[String(fromId)];
        await sendView(cfg, chatId, intent.view, fromId, needle);
        return;
      }
      if (intent.kind === "find") {
        await handleFindCommand(cfg, chatId, intent.query);
        return;
      }
      if (intent.kind === "create") {
        await handleNewCommand(cfg, chatId, fromId, intent.transcriptForExtractor);
        return;
      }
      if (intent.kind === "reviews" || intent.kind === "shoots") {
        await sendMessageHtml(
          token,
          chatId,
          `<i>${intent.kind === "reviews" ? "Reviews" : "Shoots"} view is coming next. For now try <code>/mine</code> or <code>/week</code>.</i>`,
          mainMenuKeyboard(),
        );
        return;
      }
      if (intent.kind === "help") {
        await sendMessageHtml(
          token,
          chatId,
          helpMessage(fromId, assigneeMap),
          mainMenuKeyboard(),
        );
        return;
      }
      if (intent.kind === "smalltalk") {
        await sendMessageHtml(
          token,
          chatId,
          esc(intent.reply),
          mainMenuKeyboard(),
        );
        return;
      }
    } catch (e) {
      console.warn("[ai router]", (e as Error).message);
    }
  }

  await sendMessageHtml(
    token,
    chatId,
    `Try <i>tasks due today</i> or tap a view below.\nSearch: <code>/find hotel</code>. Onboard: <code>/link</code>.` +
      (aiEnabled() ? "" : `\n\n<i>Tip: set <code>OPENAI_API_KEY</code> to unlock voice and natural-language commands.</i>`),
    mainMenuKeyboard(),
  );
}

async function handleVoiceMessage(
  token: string,
  chatId: number,
  fileId: string,
): Promise<string | null> {
  if (!aiEnabled()) {
    await sendMessageHtml(
      token,
      chatId,
      `<b>Voice needs AI</b>\n\nSet <code>OPENAI_API_KEY</code> in Vercel (and optionally <code>OPENAI_MODEL</code> / <code>OPENAI_AUDIO_MODEL</code>) to enable voice-to-task.`,
      mainMenuKeyboard(),
    );
    return null;
  }

  try {
    const { buffer, filename } = await downloadTelegramFile(token, fileId);
    const transcript = await transcribeAudio(buffer, filename);
    if (!transcript) {
      await sendMessageHtml(token, chatId, "<i>Could not transcribe. Try again?</i>");
      return null;
    }
    await sendMessageHtml(
      token,
      chatId,
      `🎙 <i>${esc(transcript)}</i>`,
    );
    return transcript;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[voice]", e);
    await sendMessageHtml(
      token,
      chatId,
      `<b>Voice transcription failed</b>\n<code>${esc(msg)}</code>`,
    );
    return null;
  }
}

async function handleTaskActionCallback(
  cfg: BotConfig,
  token: string,
  chatId: number,
  messageId: number,
  callbackId: string,
  fromId: number,
  data: string,
): Promise<void> {
  const parts = data.split(":");
  const action = parts[1];
  const shortId = parts[2] ?? "";
  if (!shortId) {
    await answerCallbackQuery(token, callbackId, "Missing task id");
    return;
  }
  const pageId = restorePageId(shortId);

  await answerCallbackQuery(token, callbackId, "Working…");
  try {
    let updated: TaskRow | null = null;
    let ackLabel = "";

    if (action === "done") {
      updated = await updateTaskStatus(cfg, pageId, "Approved");
      ackLabel = "Marked approved";
    } else if (action === "rev") {
      updated = await updateTaskStatus(cfg, pageId, "Internal review");
      ackLabel = "Sent to Internal review";
    } else if (action === "snz") {
      updated = await snoozeTaskDue(cfg, pageId, 1);
      ackLabel = "Snoozed 1 day";
    } else if (action === "cappr") {
      updated = await sendTaskForClientApproval(cfg, pageId);
      ackLabel = "Sent to client for approval";
      if (updated) {
        const managerCount = parseSocialManagerIds().length;
        if (managerCount > 0) {
          await dmSocialManagers(
            cfg,
            "Client approval requested",
            updated,
          ).catch(() => {});
        }
      }
    } else {
      await sendMessageHtml(token, chatId, "Unknown action.");
      return;
    }

    if (!updated) {
      await sendMessageHtml(token, chatId, "Could not update this task.");
      return;
    }

    await editMessageTextHtml(
      token,
      chatId,
      messageId,
      actionAckText(ackLabel, updated),
      taskActionKeyboard(updated.id, updated.url),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[task-action]", action, pageId, e);
    await sendMessageHtml(
      token,
      chatId,
      `<b>Action failed</b>\n<code>${esc(msg)}</code>\n\n` +
        `If the status name doesn't exist in Notion, add options "Internal review" and "Approved", or rename via <code>NOTION_PROP_STATUS</code>.`,
    );
  }
  // fromId reserved for future per-user permission checks on actions
  void fromId;
}

async function handleNewCommand(
  cfg: BotConfig,
  chatId: number,
  fromId: number,
  raw: string,
): Promise<void> {
  const token = cfg.telegramBotToken;
  if (!raw.trim()) {
    await sendMessageHtml(
      token,
      chatId,
      `<b>Quick task creation</b>

${
  aiEnabled()
    ? `Type <i>naturally</i> or send a <b>voice note</b>:
<i>"Reel for APX due Friday, P1, shoot next Monday"</i>

Or use the explicit syntax:
`
    : ""
}<code>/new &lt;title&gt; [· client:X] [· deliv:Y] [· due:Fri] [· priority:P1]</code>

<b>Examples</b>
<code>/new APX Reels pack · due:Fri · priority:P1</code>
<code>/new Hotel Orologio photo · client:hotel · deliv:Photo deliverable pack · due:tomorrow · shoot:+3d</code>
<code>/new Corso edit · due:2026-04-28 · assign:Albert</code>

<b>Dates</b> — ISO, <code>today</code>, <code>tomorrow</code>, <code>+2d</code>, <code>+1w</code>, or a weekday (<code>Fri</code>).
<b>Default assignee</b> — you (your Telegram id is stamped so it shows in /mine).`,
      mainMenuKeyboard(),
    );
    return;
  }

  const parsed = parseNewTaskArgs(raw);
  const hasExplicitSyntax =
    /[·|;]/.test(raw) || /\b[a-z]+\s*[:=]\s*\S/i.test(raw);

  let draft: Partial<typeof parsed> & {
    title?: string;
    client?: string;
    deliverable?: string;
    serviceLine?: string;
    priority?: string;
    status?: string;
    due?: string;
    shoot?: string;
    assignee?: string;
    unknown?: string[];
  } = parsed;
  let extracted: ExtractedTask | null = null;
  let missingFields: string[] = [];

  if (aiEnabled() && !hasExplicitSyntax) {
    try {
      const ctx = await buildExtractionContext(cfg);
      extracted = await extractNewTask(raw, ctx);
      if (extracted.title) {
        draft = {
          title: extracted.title,
          client: extracted.client || undefined,
          deliverable: extracted.deliverable || undefined,
          priority: extracted.priority || undefined,
          due: extracted.due || undefined,
          shoot: extracted.shoot || undefined,
          assignee: extracted.assignee || undefined,
          unknown: [],
        };
        missingFields = extracted.missing ?? [];
      }
    } catch (e) {
      console.warn("[new ai]", (e as Error).message);
    }
  }

  if (!draft.title) {
    await sendMessageHtml(
      token,
      chatId,
      "<b>Need a title</b>\nTry: <i>\"Reel for APX due Friday\"</i> or <code>/new Title · due:Fri</code>",
      mainMenuKeyboard(),
    );
    return;
  }

  if (!draft.assignee) {
    const myAssignee = await findAssigneeForTelegramId(cfg, fromId).catch(
      () => null,
    );
    if (myAssignee) draft.assignee = myAssignee;
  }

  try {
    const row = await createProductionTask(cfg, {
      title: draft.title,
      client: draft.client,
      deliverable: draft.deliverable,
      serviceLine: draft.serviceLine,
      priority: draft.priority,
      status: draft.status,
      due: draft.due,
      shoot: draft.shoot,
      assignee: draft.assignee,
      telegramUserId: fromId,
    });

    const notes: string[] = [];
    if (draft.unknown && draft.unknown.length > 0) {
      notes.push(
        `<i>Ignored tokens:</i> <code>${esc(draft.unknown.join(" · "))}</code>`,
      );
    }
    if (missingFields.length > 0) {
      notes.push(
        `<i>Tip — missing:</i> ${missingFields
          .slice(0, 4)
          .map((f) => `<code>${esc(f)}</code>`)
          .join(" · ")}. Reply with e.g. <code>due:Mon</code> or <code>priority:P1</code>.`,
      );
    }
    const noteLine = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";

    await sendMessageHtml(
      token,
      chatId,
      `<b>Task created</b>${noteLine}\n\n${formatTaskCard(row)}`,
      taskActionKeyboard(row.id, row.url),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[new]", e);
    await sendMessageHtml(
      token,
      chatId,
      `<b>Could not create</b>\n<code>${esc(msg)}</code>`,
      mainMenuKeyboard(),
    );
  }
}

async function buildExtractionContext(
  cfg: BotConfig,
): Promise<ExtractionContext> {
  const [catalog, statuses] = await Promise.all([
    loadAssigneeLinkCatalog(cfg).catch(() => ({
      displayNames: [],
      emailToDisplay: {},
    })),
    fetchStatusOptionNames(cfg).catch(() => [] as string[]),
  ]);
  return {
    knownClients: [],
    knownAssignees: catalog.displayNames,
    knownDeliverables: [],
    knownPriorities: [
      "P0 — Today",
      "P1 — This week",
      "P2 — Later this week",
      "P3 — Later this month",
    ],
    knownStatuses: statuses,
  };
}

async function handleFindCommand(
  cfg: BotConfig,
  chatId: number,
  q: string,
): Promise<void> {
  const token = cfg.telegramBotToken;
  if (!q) {
    await sendMessageHtml(
      token,
      chatId,
      `<b>Find a task</b>\n\n<code>/find hotel</code>\n<code>/find APX reel</code>\n<code>/find changes</code>`,
      mainMenuKeyboard(),
    );
    return;
  }
  try {
    const rows = await searchProductionTasks(cfg, q, 8);
    if (rows.length === 0) {
      await sendMessageHtml(
        token,
        chatId,
        `No open tasks matched <b>${esc(q)}</b>.`,
        mainMenuKeyboard(),
      );
      return;
    }
    await sendMessageHtml(
      token,
      chatId,
      `${headerLine("Find")} · <i>${rows.length} match${rows.length === 1 ? "" : "es"} for “${esc(q)}”</i>`,
      mainMenuKeyboard(),
    );
    for (const r of rows) {
      await sendMessageHtml(
        token,
        chatId,
        formatTaskCard(r),
        taskActionKeyboard(r.id, r.url),
      );
    }
  } catch (e) {
    console.error("[find]", e);
    await sendMessageHtml(
      token,
      chatId,
      `<b>Search failed</b>\nCheck Notion access and property names.`,
      mainMenuKeyboard(),
    );
  }
}

function welcomeMessage(
  telegramUserId: number,
  map: Record<string, string>,
  notionTeamDir: boolean,
): string {
  const linked = Boolean(map[String(telegramUserId)]);
  const linkHint = linked
    ? "You're linked for <b>My queue</b>."
    : "Tap <b>🔗 Link account</b> or run <code>/link Your Name</code> to see your queue instantly.";
  void notionTeamDir;
  return `<b>Anvance Production</b>\n<i>Telegram · Notion task desk</i>\n\n${linkHint}\n\n<b>Do it fast</b>\n• <code>/today</code> · <code>/week</code> · <code>/mine</code> · <code>/overdue</code>\n• Tap <b>➕ New task</b> — guided step-by-step, no syntax needed\n• Or <code>/new Title · due:Fri · client:X</code> for power users\n• <code>/find hotel</code> — search any task\n• Tap a card to <b>Review</b>, <b>Send to client</b>, <b>Done</b>, or <b>Snooze</b>.`;
}

function helpMessage(
  telegramUserId: number,
  map: Record<string, string>,
): string {
  const idLine = `Your Telegram user id: <code>${telegramUserId}</code>`;
  const mapLine =
    Object.keys(map).length === 0
      ? "No assignee links loaded (using Production's Telegram id column directly)."
      : `Assignee links on file: <b>${Object.keys(map).length}</b>`;
  return `${idLine}\n${mapLine}\n\n<b>Commands</b>\n<code>/today</code> · <code>/week</code> · <code>/mine</code> · <code>/overdue</code> · <code>/board</code>\n<code>/find &lt;keyword&gt;</code> — search tasks\n<code>/new</code> — <b>guided wizard</b> (title → client → deliverable → due → priority → shoot)\n<code>/new &lt;title&gt; · due:Fri</code> — one-shot create for power users\n<code>/cancel</code> — abort an in-progress new task\n<code>/link Your Name</code> — stamp Telegram id on your Production rows\n<code>/start</code> · <code>/help</code>\n\n<b>On a task card</b>\n• 🔗 Open in Notion\n• 🔍 Review → Internal review\n• ✈️ Send to client → Client approval = Sent + DM social manager\n• ✅ Done → Approved\n• ⏰ Snooze 1d → bumps Due\n\n<b>Ops</b> (managers, if enabled): <code>/ops help</code>\n\n<b>Natural language</b>\n<i>what are my tasks today</i> · <i>this week</i> · <i>team board</i> · <i>overdue</i>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function linkInstructionsHtml(): string {
  return `<b>Link your Telegram account</b>

Tell me who you are in Notion:

• <b>Name</b> — the exact Assignee text on tasks
• <b>Work email</b> — same email Notion has for you (when visible to the integration)

<code>/link Albert Rhey Embalsado</code>
<code>/link you@company.com</code>

I'll stamp your Telegram id onto your open Production tasks so <b>/mine</b> just works.`;
}

function linkNoAssigneesHtml(): string {
  return `<b>No assignees found</b> on open Production tasks.

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
  updated: number,
  skipped: number,
): string {
  const note =
    mode === "unique_partial"
      ? "\n<i>Matched from a partial name — re-run <code>/link</code> with the full name anytime.</i>"
      : mode === "email"
        ? "\n<i>Matched by workspace email from Notion.</i>"
        : "";
  return `<b>Linked ✅</b>

<code>${esc(assignee)}</code>
Updated <b>${updated}</b> open task${updated === 1 ? "" : "s"} (skipped ${skipped}).

Open <b>/mine</b> when ready.${note}`;
}

function linkErrorHtml(message: string): string {
  return `<b>Could not save link</b>\n\n<code>${esc(message)}</code>\n\nCheck that Production has a Telegram id column (default <code>Telegram user id</code>) and the integration has edit access.`;
}

async function handleLinkCommand(
  cfg: BotConfig,
  token: string,
  chatId: number,
  fromId: number,
  nameArg: string,
  notionTeamDir: boolean,
): Promise<void> {
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
        linkNoAssigneesHtml(),
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

    const { updated, skipped } = await stampTelegramIdOnProductionForAssignee(
      cfg,
      fromId,
      match.assignee,
    );

    if (notionTeamDir) {
      try {
        await upsertTeamTelegramLink(cfg, fromId, match.assignee);
      } catch (e) {
        console.warn(
          "[link] team-link mirror upsert failed (non-fatal)",
          (e as Error).message,
        );
      }
    }

    await sendMessageHtml(
      token,
      chatId,
      linkSuccessHtml(match.assignee, match.mode, updated, skipped),
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
