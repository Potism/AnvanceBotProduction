type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

type ReplyMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export async function tgApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  let data: { ok?: boolean; description?: string } = {};
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${text}`);
  }
  // Telegram often returns HTTP 200 with {"ok":false,"description":"..."} (e.g. bad token, chat not found).
  if (data.ok === false) {
    throw new Error(
      `Telegram ${method} rejected: ${data.description ?? (text || "unknown")}`,
    );
  }
}

export async function sendMessageHtml(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: ReplyMarkup,
): Promise<void> {
  await tgApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  });
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await tgApi(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: Boolean(text && text.length > 180),
  });
}

export function mainMenuKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Today", callback_data: "v:today" },
        { text: "This week", callback_data: "v:week" },
      ],
      [
        { text: "My queue", callback_data: "v:mine" },
        { text: "Team board", callback_data: "v:board" },
      ],
      [{ text: "Help", callback_data: "v:help" }],
    ],
  };
}
