import type { BotConfig } from "../types";
import { createProductionTask, findAssigneeForTelegramId } from "../notion/actions";
import { loadProductionCatalog } from "../notion/production-catalog";
import { parseFriendlyDate } from "./new-task-parse";
import { aiEnabled, aiParseDate } from "../ai/openai";
import {
  editMessageTextHtml,
  sendMessageHtml,
  type InlineKeyboardButton,
  type ReplyMarkup,
} from "../telegram/client";
import { formatTaskCard } from "../telegram/format";
import { taskActionKeyboard } from "../telegram/client";
import { answerCallbackQuery } from "../telegram/client";

type Step =
  | "title"
  | "client"
  | "deliverable"
  | "due"
  | "priority"
  | "shoot"
  | "review"
  | "custom_client"
  | "custom_deliverable"
  | "custom_due"
  | "custom_shoot"
  | "custom_title";

type Draft = {
  title?: string;
  client?: string;
  deliverable?: string;
  priority?: string;
  due?: string;
  shoot?: string;
};

type Session = {
  chatId: number;
  userId: number;
  messageId?: number;
  step: Step;
  draft: Draft;
  clients: string[];
  deliverables: string[];
  /** Calendar view year/month (0-indexed) while the calendar is open. */
  calYear?: number;
  calMonth?: number;
  /** Which field the calendar is picking: "due" | "sht". */
  calField?: "d" | "s";
  expires: number;
};

const TTL_MS = 30 * 60_000;
const sessions = new Map<number, Session>();

function touch(s: Session) {
  s.expires = Date.now() + TTL_MS;
  sessions.set(s.userId, s);
}

function get(userId: number): Session | null {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(userId);
    return null;
  }
  return s;
}

function clear(userId: number) {
  sessions.delete(userId);
}

export function hasActiveWizard(userId: number): boolean {
  return get(userId) !== null;
}

export function cancelWizard(userId: number): boolean {
  const had = sessions.has(userId);
  sessions.delete(userId);
  return had;
}

const PRIORITIES = [
  { code: "p0", label: "P0 · Today", value: "P0 - Today" },
  { code: "p1", label: "P1 · This week", value: "P1 - This week" },
  { code: "p2", label: "P2 · Later this week", value: "P2 - Later this week" },
  { code: "p3", label: "P3 · Later this month", value: "P3 - Later this month" },
];

function kbCancelRow(): InlineKeyboardButton[] {
  return [{ text: "✖ Cancel", callback_data: "n:cnc" }];
}

function kbSkipRow(): InlineKeyboardButton[] {
  return [{ text: "⏭ Skip", callback_data: "n:skp" }];
}

function optionButtons(
  prefix: string,
  options: string[],
  max = 8,
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  const show = options.slice(0, max);
  for (let i = 0; i < show.length; i += 2) {
    const a = show[i];
    const b = show[i + 1];
    const row: InlineKeyboardButton[] = [
      {
        text: truncateLabel(a),
        callback_data: `${prefix}:${i}`,
      },
    ];
    if (b !== undefined) {
      row.push({
        text: truncateLabel(b),
        callback_data: `${prefix}:${i + 1}`,
      });
    }
    rows.push(row);
  }
  return rows;
}

function truncateLabel(s: string): string {
  return s.length > 28 ? `${s.slice(0, 27)}…` : s;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function draftLines(d: Draft): string {
  const pairs: Array<[string, string | undefined]> = [
    ["📝 Title", d.title],
    ["🏷 Client", d.client],
    ["📦 Deliverable", d.deliverable],
    ["📅 Due", d.due],
    ["🎬 Shoot", d.shoot],
    ["⚡ Priority", d.priority],
  ];
  return pairs
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: <b>${esc(v as string)}</b>`)
    .join("\n");
}

function stepHeader(step: Step, d: Draft): string {
  const filled = draftLines(d);
  const head = filled ? `<b>New task</b>\n${filled}\n\n` : "<b>New task</b>\n\n";
  switch (step) {
    case "title":
    case "custom_title":
      return `${head}<b>Step 1/5 · Title</b>\nType the task title <i>or send a voice note</i>.`;
    case "client":
      return `${head}<b>Step 2/5 · Client</b>\nPick one, type a custom name, or skip.`;
    case "custom_client":
      return `${head}<b>Step 2/5 · Client</b>\nType the client name.`;
    case "deliverable":
      return `${head}<b>Step 3/5 · Deliverable</b>\nPick one, type a custom value, or skip.`;
    case "custom_deliverable":
      return `${head}<b>Step 3/5 · Deliverable</b>\nType the deliverable name.`;
    case "due":
      return `${head}<b>Step 4/5 · Due date</b>\nTap a day on the calendar, use the shortcuts, or <i>type anything</i> (e.g. <code>next friday</code>, <code>end of month</code>, <code>+3d</code>).`;
    case "custom_due":
      return `${head}<b>Step 4/5 · Due date</b>\nType the date — natural language works: <i>next friday</i>, <i>end of month</i>, <i>+3d</i>, <i>2026-05-01</i>.`;
    case "priority":
      return `${head}<b>Step 5/5 · Priority</b>\nPick one or skip.`;
    case "shoot":
      return `${head}<b>Optional · Shoot date</b>\nTap a day, use a shortcut, or type anything.`;
    case "custom_shoot":
      return `${head}<b>Optional · Shoot date</b>\nType the date — natural language works.`;
    case "review":
      return `${head}<b>Review</b>\nCreate this task?`;
  }
}

// ── Calendar ─────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function todayUTC(): { y: number; m: number; d: number } {
  const now = new Date();
  return {
    y: now.getUTCFullYear(),
    m: now.getUTCMonth(),
    d: now.getUTCDate(),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoFromYMD(y: number, m0: number, d: number): string {
  return `${y}-${pad2(m0 + 1)}-${pad2(d)}`;
}

function calendarKeyboard(field: "d" | "s", year: number, month0: number): ReplyMarkup {
  const first = new Date(Date.UTC(year, month0, 1));
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  // Monday-first week: Mon=0, Sun=6.
  const firstCol = (first.getUTCDay() + 6) % 7;

  const today = todayUTC();
  const todayISO = isoFromYMD(today.y, today.m, today.d);

  const rows: InlineKeyboardButton[][] = [];

  // Header row: ‹  Month Year  ›
  rows.push([
    { text: "‹", callback_data: `n:c:${field}:p` },
    { text: `${MONTH_NAMES[month0]} ${year}`, callback_data: "n:c:_" },
    { text: "›", callback_data: `n:c:${field}:n` },
  ]);

  // Weekday header
  rows.push(
    ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((w) => ({
      text: w,
      callback_data: "n:c:_",
    })),
  );

  // Day cells
  let row: InlineKeyboardButton[] = [];
  for (let i = 0; i < firstCol; i++) {
    row.push({ text: " ", callback_data: "n:c:_" });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoFromYMD(year, month0, d);
    const label = iso === todayISO ? `·${d}·` : String(d);
    row.push({ text: label, callback_data: `n:c:${field}:d:${iso}` });
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) {
    while (row.length < 7) row.push({ text: " ", callback_data: "n:c:_" });
    rows.push(row);
  }

  // Footer shortcuts
  rows.push([
    { text: "📅 Today", callback_data: `n:c:${field}:t` },
    { text: "➡️ Tomorrow", callback_data: `n:c:${field}:tm` },
  ]);
  rows.push([
    { text: "✍️ Type date", callback_data: `n:c:${field}:cst` },
    { text: "⏭ Skip", callback_data: "n:skp" },
  ]);
  rows.push(kbCancelRow());
  return { inline_keyboard: rows };
}

function stepNeedsCalendar(step: Step): "d" | "s" | null {
  if (step === "due") return "d";
  if (step === "shoot") return "s";
  return null;
}

function keyboardFor(session: Session): ReplyMarkup {
  switch (session.step) {
    case "title":
    case "custom_title":
    case "custom_client":
    case "custom_deliverable":
    case "custom_due":
    case "custom_shoot":
      return { inline_keyboard: [kbCancelRow()] };

    case "client": {
      const rows = optionButtons("n:cli", session.clients, 8);
      rows.push([
        { text: "✍️ Type custom", callback_data: "n:cli_cst" },
        { text: "⏭ Skip", callback_data: "n:skp" },
      ]);
      rows.push(kbCancelRow());
      return { inline_keyboard: rows };
    }
    case "deliverable": {
      const rows = optionButtons("n:del", session.deliverables, 8);
      rows.push([
        { text: "✍️ Type custom", callback_data: "n:del_cst" },
        { text: "⏭ Skip", callback_data: "n:skp" },
      ]);
      rows.push(kbCancelRow());
      return { inline_keyboard: rows };
    }
    case "due": {
      const t = todayUTC();
      const y = session.calYear ?? t.y;
      const m = session.calMonth ?? t.m;
      return calendarKeyboard("d", y, m);
    }
    case "shoot": {
      const t = todayUTC();
      const y = session.calYear ?? t.y;
      const m = session.calMonth ?? t.m;
      return calendarKeyboard("s", y, m);
    }
    case "priority":
      return {
        inline_keyboard: [
          [
            { text: "🔴 P0", callback_data: "n:prio:p0" },
            { text: "🟠 P1", callback_data: "n:prio:p1" },
          ],
          [
            { text: "🟡 P2", callback_data: "n:prio:p2" },
            { text: "⚪ P3", callback_data: "n:prio:p3" },
          ],
          kbSkipRow(),
          kbCancelRow(),
        ],
      };
    case "review":
      return {
        inline_keyboard: [
          [{ text: "✅ Create task", callback_data: "n:cre" }],
          [
            { text: "✏️ Edit title", callback_data: "n:ed:title" },
            { text: "✏️ Edit client", callback_data: "n:ed:client" },
          ],
          [
            { text: "✏️ Edit deliverable", callback_data: "n:ed:deliverable" },
            { text: "✏️ Edit due", callback_data: "n:ed:due" },
          ],
          [
            { text: "✏️ Edit shoot", callback_data: "n:ed:shoot" },
            { text: "✏️ Edit priority", callback_data: "n:ed:priority" },
          ],
          kbCancelRow(),
        ],
      };
  }
}

async function render(cfg: BotConfig, s: Session): Promise<void> {
  const token = cfg.telegramBotToken;
  const text = stepHeader(s.step, s.draft);
  const kb = keyboardFor(s);
  if (s.messageId) {
    await editMessageTextHtml(token, s.chatId, s.messageId, text, kb);
  } else {
    // We can't capture the new message id from sendMessageHtml today; send and let
    // subsequent edits fall back to a new message (still works — edit fails are silent).
    await sendMessageHtml(token, s.chatId, text, kb);
  }
  touch(s);
}

/** Entry point — called when user types /new with no args, or taps the button.
 *  If `initialTitle` is provided (e.g. `/new wedding shoot`), we skip step 1
 *  and jump straight to the client picker. */
export async function startWizard(
  cfg: BotConfig,
  chatId: number,
  userId: number,
  messageId?: number,
  initialTitle?: string,
): Promise<void> {
  const t = (initialTitle ?? "").trim();
  const s: Session = {
    chatId,
    userId,
    messageId,
    step: t ? "client" : "title",
    draft: t ? { title: t } : {},
    clients: [],
    deliverables: [],
    expires: Date.now() + TTL_MS,
  };
  sessions.set(userId, s);

  // Fire-and-forget catalog load; wizard works without it (Skip/Type custom still available).
  loadProductionCatalog(cfg)
    .then((cat) => {
      const cur = get(userId);
      if (!cur) return;
      cur.clients = cat.clients;
      cur.deliverables = cat.deliverables;
      touch(cur);
    })
    .catch(() => {});

  await render(cfg, s);
}

/** Text reply during a wizard step. Returns true if consumed. */
export async function handleWizardText(
  cfg: BotConfig,
  userId: number,
  text: string,
): Promise<boolean> {
  const s = get(userId);
  if (!s) return false;
  const v = text.trim();
  if (!v) return true;

  switch (s.step) {
    case "title":
    case "custom_title":
      s.draft.title = v;
      s.step = "client";
      break;
    case "custom_client":
      s.draft.client = v;
      s.step = "deliverable";
      break;
    case "custom_deliverable":
      s.draft.deliverable = v;
      s.step = "due";
      break;
    case "custom_due": {
      const iso = await resolveDate(v);
      if (!iso) {
        await sendMessageHtml(
          cfg.telegramBotToken,
          s.chatId,
          `<i>Didn't understand "${esc(v)}". Try <code>next friday</code>, <code>end of month</code>, <code>+3d</code>, or <code>2026-05-01</code>.</i>`,
        );
        return true;
      }
      s.draft.due = iso;
      s.step = "priority";
      break;
    }
    case "custom_shoot": {
      const iso = await resolveDate(v);
      if (!iso) {
        await sendMessageHtml(
          cfg.telegramBotToken,
          s.chatId,
          `<i>Didn't understand "${esc(v)}". Try <code>next friday</code>, <code>+3d</code>, or <code>2026-05-01</code>.</i>`,
        );
        return true;
      }
      s.draft.shoot = iso;
      s.step = "review";
      break;
    }
    default:
      // User sent text during a button step. If step is one that accepts optional
      // free text (client/deliverable), accept it.
      if (s.step === "client") {
        s.draft.client = v;
        s.step = "deliverable";
      } else if (s.step === "deliverable") {
        s.draft.deliverable = v;
        s.step = "due";
      } else if (s.step === "due") {
        const iso = await resolveDate(v);
        if (!iso) {
          await sendMessageHtml(
            cfg.telegramBotToken,
            s.chatId,
            `<i>Didn't understand "${esc(v)}". Try <code>next friday</code>, <code>end of month</code>, <code>+3d</code>, or <code>2026-05-01</code>.</i>`,
          );
          return true;
        }
        s.draft.due = iso;
        s.step = "priority";
      } else if (s.step === "shoot") {
        const iso = await resolveDate(v);
        if (!iso) {
          await sendMessageHtml(
            cfg.telegramBotToken,
            s.chatId,
            `<i>Didn't understand "${esc(v)}". Try <code>next friday</code>, <code>+3d</code>, or <code>2026-05-01</code>.</i>`,
          );
          return true;
        }
        s.draft.shoot = iso;
        s.step = "review";
      } else {
        return true;
      }
  }

  // After text is captured, subsequent messages should be new cards (can't edit).
  s.messageId = undefined;
  await render(cfg, s);
  return true;
}

/** Button callback during a wizard step. Returns true if consumed. */
export async function handleWizardCallback(
  cfg: BotConfig,
  userId: number,
  chatId: number,
  messageId: number,
  callbackId: string,
  data: string,
): Promise<boolean> {
  if (!data.startsWith("n:")) return false;
  const token = cfg.telegramBotToken;

  // Starting the wizard from the main menu button
  if (data === "n:start") {
    await answerCallbackQuery(token, callbackId);
    await startWizard(cfg, chatId, userId);
    return true;
  }

  const s = get(userId);
  if (!s) {
    await answerCallbackQuery(token, callbackId, "Session expired — tap “New task” again.");
    return true;
  }
  // Lock session to the latest message id we're editing
  s.chatId = chatId;
  s.messageId = messageId;

  await answerCallbackQuery(token, callbackId);

  const parts = data.split(":"); // "n", action, maybe value

  if (parts[1] === "cnc") {
    clear(userId);
    await editMessageTextHtml(token, chatId, messageId, "<i>New task cancelled.</i>");
    return true;
  }

  if (parts[1] === "skp") {
    advanceSkip(s);
    await render(cfg, s);
    return true;
  }

  if (parts[1] === "cli") {
    const idx = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isFinite(idx) && s.clients[idx]) {
      s.draft.client = s.clients[idx];
      s.step = "deliverable";
      await render(cfg, s);
    }
    return true;
  }
  if (parts[1] === "cli_cst") {
    s.step = "custom_client";
    s.messageId = undefined;
    await sendMessageHtml(token, chatId, stepHeader(s.step, s.draft), keyboardFor(s));
    touch(s);
    return true;
  }

  if (parts[1] === "del") {
    const idx = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isFinite(idx) && s.deliverables[idx]) {
      s.draft.deliverable = s.deliverables[idx];
      s.step = "due";
      await render(cfg, s);
    }
    return true;
  }
  if (parts[1] === "del_cst") {
    s.step = "custom_deliverable";
    s.messageId = undefined;
    await sendMessageHtml(token, chatId, stepHeader(s.step, s.draft), keyboardFor(s));
    touch(s);
    return true;
  }

  // Calendar: n:c:<field>:<action>[:<iso>]
  //   field = "d" | "s"   action = "p" | "n" | "d" | "t" | "tm" | "cst" | "_"
  if (parts[1] === "c") {
    if (parts[2] === "_") return true; // noop (header / empty cell)
    const field = parts[2] as "d" | "s";
    const action = parts[3] ?? "";
    const t = todayUTC();
    let y = s.calYear ?? t.y;
    let m = s.calMonth ?? t.m;

    if (action === "p") {
      m -= 1;
      if (m < 0) { m = 11; y -= 1; }
      s.calYear = y;
      s.calMonth = m;
      await render(cfg, s);
      return true;
    }
    if (action === "n") {
      m += 1;
      if (m > 11) { m = 0; y += 1; }
      s.calYear = y;
      s.calMonth = m;
      await render(cfg, s);
      return true;
    }
    if (action === "t" || action === "tm") {
      const iso = action === "t"
        ? isoFromYMD(t.y, t.m, t.d)
        : parseFriendlyDate("tomorrow");
      if (iso) assignDate(s, field, iso);
      resetCalendar(s);
      await render(cfg, s);
      return true;
    }
    if (action === "d") {
      const iso = parts.slice(4).join(":");
      if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        assignDate(s, field, iso);
        resetCalendar(s);
        await render(cfg, s);
      }
      return true;
    }
    if (action === "cst") {
      s.step = field === "d" ? "custom_due" : "custom_shoot";
      resetCalendar(s);
      s.messageId = undefined;
      await sendMessageHtml(token, chatId, stepHeader(s.step, s.draft), keyboardFor(s));
      touch(s);
      return true;
    }
    return true;
  }

  if (parts[1] === "prio") {
    const code = parts[2] ?? "";
    const p = PRIORITIES.find((x) => x.code === code);
    if (p) s.draft.priority = p.value;
    s.step = "shoot";
    await render(cfg, s);
    return true;
  }

  if (parts[1] === "ed") {
    const field = parts[2];
    if (field === "title") s.step = "custom_title";
    else if (field === "client") s.step = "custom_client";
    else if (field === "deliverable") s.step = "custom_deliverable";
    else if (field === "due") s.step = "custom_due";
    else if (field === "shoot") s.step = "custom_shoot";
    else if (field === "priority") s.step = "priority";
    s.messageId = undefined;
    if (s.step === "priority") {
      await render(cfg, s);
    } else {
      await sendMessageHtml(token, chatId, stepHeader(s.step, s.draft), keyboardFor(s));
      touch(s);
    }
    return true;
  }

  if (parts[1] === "cre") {
    await createFromDraft(cfg, s);
    clear(userId);
    return true;
  }

  return true; // consumed
}

/** Deterministic parser first (fast, free), AI fallback for fuzzy phrases. */
async function resolveDate(raw: string): Promise<string | null> {
  const direct = parseFriendlyDate(raw);
  if (direct) return direct;
  if (!aiEnabled()) return null;
  const t = todayUTC();
  return aiParseDate(raw, isoFromYMD(t.y, t.m, t.d));
}

function assignDate(s: Session, field: "d" | "s", iso: string) {
  if (field === "d") {
    s.draft.due = iso;
    s.step = "priority";
  } else {
    s.draft.shoot = iso;
    s.step = "review";
  }
}

function resetCalendar(s: Session) {
  s.calYear = undefined;
  s.calMonth = undefined;
  s.calField = undefined;
}

function advanceSkip(s: Session) {
  switch (s.step) {
    case "client":
      s.step = "deliverable";
      break;
    case "deliverable":
      s.step = "due";
      break;
    case "due":
      s.step = "priority";
      break;
    case "priority":
      s.step = "shoot";
      break;
    case "shoot":
      s.step = "review";
      break;
    default:
      break;
  }
}

async function createFromDraft(cfg: BotConfig, s: Session): Promise<void> {
  const token = cfg.telegramBotToken;
  if (!s.draft.title) {
    await sendMessageHtml(token, s.chatId, "<i>Need at least a title.</i>");
    return;
  }

  let assignee: string | undefined;
  try {
    const a = await findAssigneeForTelegramId(cfg, s.userId);
    if (a) assignee = a;
  } catch {
    /* non-fatal */
  }

  try {
    const row = await createProductionTask(cfg, {
      title: s.draft.title,
      client: s.draft.client,
      deliverable: s.draft.deliverable,
      priority: s.draft.priority,
      due: s.draft.due,
      shoot: s.draft.shoot,
      assignee,
      telegramUserId: s.userId,
    });
    if (s.messageId) {
      await editMessageTextHtml(
        token,
        s.chatId,
        s.messageId,
        `<b>Task created ✅</b>\n\n${formatTaskCard(row)}`,
        taskActionKeyboard(row.id, row.url),
      );
    } else {
      await sendMessageHtml(
        token,
        s.chatId,
        `<b>Task created ✅</b>\n\n${formatTaskCard(row)}`,
        taskActionKeyboard(row.id, row.url),
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sendMessageHtml(
      token,
      s.chatId,
      `<b>Could not create</b>\n<code>${esc(msg)}</code>\n\n<i>Draft kept — type <code>/new</code> to restart.</i>`,
    );
  }
}
