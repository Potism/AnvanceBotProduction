import {
  findTeamLinkAssigneeForTg,
  listTeamLinkRowPreviews,
  upsertTeamTelegramLink,
} from "../notion/team-link-upsert";
import { loadAssigneeLinkCatalog, matchAssigneeInput } from "../notion/production-assignees";
import type { BotConfig } from "../types";
import { mainMenuKeyboard, sendMessageHtml } from "../telegram/client";

function parseOpsUserIds(): Set<number> {
  const raw = process.env.TELEGRAM_OPS_USER_IDS?.trim();
  if (!raw) return new Set();
  try {
    const j = JSON.parse(raw) as unknown;
    if (Array.isArray(j)) {
      return new Set(
        j
          .map((x) => (typeof x === "number" ? x : Number(String(x))))
          .filter((n) => Number.isFinite(n) && n > 0) as number[],
      );
    }
  } catch {
    /* fall through */
  }
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
}

export function isOpsTelegramUser(fromId: number): boolean {
  return parseOpsUserIds().has(fromId);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Handles /ops … for users listed in TELEGRAM_OPS_USER_IDS.
 * Returns true if the message was consumed.
 */
export async function tryHandleOpsCommand(
  cfg: BotConfig,
  token: string,
  chatId: number,
  fromId: number,
  text: string,
): Promise<boolean> {
  if (!/^\/ops(?:@\S*)?(\s|$)/i.test(text)) return false;

  const allowed = parseOpsUserIds();
  if (allowed.size === 0) {
    await sendMessageHtml(
      token,
      chatId,
      "<b>/ops</b> is not enabled.\n\nSet <code>TELEGRAM_OPS_USER_IDS</code> in Vercel (JSON array of Telegram numeric ids), redeploy.",
      mainMenuKeyboard(),
    );
    return true;
  }
  if (!allowed.has(fromId)) {
    await sendMessageHtml(
      token,
      chatId,
      "<b>Not authorized</b> for /ops. Ask ops to add your Telegram id to <code>TELEGRAM_OPS_USER_IDS</code>.",
      mainMenuKeyboard(),
    );
    return true;
  }

  const body = text.replace(/^\/ops(?:@\S*)?\s*/i, "").trim();
  const parts = body.split(/\s+/).filter(Boolean);

  if (!body || parts[0]?.toLowerCase() === "help") {
    await sendMessageHtml(
      token,
      chatId,
      `<b>Ops — team link</b>

<code>/ops team</code> — last rows in team link DB
<code>/ops check 6160849706</code> — is this Telegram id linked?
<code>/ops link 6160849706 Full Name</code> — link on behalf (name should match Production assignee)
<code>/ops linkmail 6160849706 you@co.com</code> — link via email (must match /link rules)`,
      mainMenuKeyboard(),
    );
    return true;
  }

  const cmd = parts[0]?.toLowerCase();

  if (cmd === "team") {
    try {
      const rows = await listTeamLinkRowPreviews(cfg, 20);
      if (rows.length === 0) {
        await sendMessageHtml(
          token,
          chatId,
          "<b>Team link DB</b> — no rows returned (empty or no access).",
          mainMenuKeyboard(),
        );
        return true;
      }
      const lines = rows
        .map((r) => `• <code>${esc(r.telegram)}</code> → ${esc(r.assignee)}`)
        .join("\n");
      await sendMessageHtml(
        token,
        chatId,
        `<b>Team link</b> (up to 20)\n\n${lines}`,
        mainMenuKeyboard(),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sendMessageHtml(
        token,
        chatId,
        `<b>Ops error</b>\n<code>${esc(msg)}</code>`,
        mainMenuKeyboard(),
      );
    }
    return true;
  }

  if (cmd === "check" && parts[1]) {
    const tid = Number(parts[1].replace(/\D/g, ""));
    if (!Number.isFinite(tid) || tid <= 0) {
      await sendMessageHtml(
        token,
        chatId,
        "Usage: <code>/ops check TELEGRAM_NUMERIC_ID</code>",
        mainMenuKeyboard(),
      );
      return true;
    }
    const a = await findTeamLinkAssigneeForTg(cfg, tid);
    if (!a) {
      await sendMessageHtml(
        token,
        chatId,
        `<b>Not linked</b>\nNo team row for <code>${tid}</code>.`,
        mainMenuKeyboard(),
      );
    } else {
      await sendMessageHtml(
        token,
        chatId,
        `<b>Linked</b>\n<code>${tid}</code> → <code>${esc(a)}</code>`,
        mainMenuKeyboard(),
      );
    }
    return true;
  }

  if (cmd === "link" && parts.length >= 3) {
    const tid = Number(parts[1].replace(/\D/g, ""));
    const nameRest = parts.slice(2).join(" ").trim();
    if (!Number.isFinite(tid) || tid <= 0 || !nameRest) {
      await sendMessageHtml(
        token,
        chatId,
        "Usage: <code>/ops link TELEGRAM_ID Full Assignee Name</code>",
        mainMenuKeyboard(),
      );
      return true;
    }
    try {
      await upsertTeamTelegramLink(cfg, tid, nameRest);
      await sendMessageHtml(
        token,
        chatId,
        `<b>Linked</b>\n<code>${tid}</code> → <code>${esc(nameRest)}</code>`,
        mainMenuKeyboard(),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sendMessageHtml(
        token,
        chatId,
        `<b>Could not save</b>\n<code>${esc(msg)}</code>`,
        mainMenuKeyboard(),
      );
    }
    return true;
  }

  if (cmd === "linkmail" && parts.length >= 3) {
    const tid = Number(parts[1].replace(/\D/g, ""));
    const email = parts.slice(2).join(" ").trim().toLowerCase();
    if (!Number.isFinite(tid) || tid <= 0 || !email.includes("@")) {
      await sendMessageHtml(
        token,
        chatId,
        "Usage: <code>/ops linkmail TELEGRAM_ID email@domain</code>",
        mainMenuKeyboard(),
      );
      return true;
    }
    try {
      const catalog = await loadAssigneeLinkCatalog(cfg);
      const match = matchAssigneeInput(email, catalog);
      if (!match.ok) {
        await sendMessageHtml(
          token,
          chatId,
          `<b>Email not in catalog</b>\n<code>${esc(email)}</code> did not resolve. Use <code>/ops link …</code> with a display name.`,
          mainMenuKeyboard(),
        );
        return true;
      }
      await upsertTeamTelegramLink(cfg, tid, match.assignee);
      await sendMessageHtml(
        token,
        chatId,
        `<b>Linked</b>\n<code>${tid}</code> → <code>${esc(match.assignee)}</code> (via email)`,
        mainMenuKeyboard(),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sendMessageHtml(
        token,
        chatId,
        `<b>Could not save</b>\n<code>${esc(msg)}</code>`,
        mainMenuKeyboard(),
      );
    }
    return true;
  }

  await sendMessageHtml(
    token,
    chatId,
    "Unknown /ops command. Try <code>/ops help</code>",
    mainMenuKeyboard(),
  );
  return true;
}
