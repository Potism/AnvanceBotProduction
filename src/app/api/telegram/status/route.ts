import { getBotConfig, isBotConfigured } from "@/lib/config";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Protected diagnostics: env presence (no secrets) + Telegram getWebhookInfo / getMe.
 * GET /api/telegram/status?secret=ADMIN_SETUP_SECRET
 */
export async function GET(req: NextRequest) {
  const admin = req.nextUrl.searchParams.get("secret");
  if (!admin || admin !== process.env.ADMIN_SETUP_SECRET) {
    return new Response("Not found", { status: 404 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return Response.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN missing" },
      { status: 400 },
    );
  }

  const [infoRes, meRes] = await Promise.all([
    fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`),
    fetch(`https://api.telegram.org/bot${token}/getMe`),
  ]);

  const info = (await infoRes.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: {
      url?: string;
      last_error_message?: string;
      pending_update_count?: number;
    };
  };
  const me = await meRes.json().catch(() => ({}));

  const cfg = getBotConfig();
  const hints: string[] = [];

  if (!isBotConfigured()) {
    hints.push(
      "Bot handler needs NOTION_TOKEN + NOTION_DATABASE_ID + TELEGRAM_BOT_TOKEN on Vercel (Production), then redeploy.",
    );
  }

  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    hints.push(
      "TELEGRAM_WEBHOOK_SECRET is set: every update must include header X-Telegram-Bot-Api-Secret-Token with the same value. Re-run set-webhook, or remove TELEGRAM_WEBHOOK_SECRET and set-webhook again without secret_token.",
    );
  }

  const lastErr = info.result?.last_error_message;
  if (lastErr) {
    hints.push(`Telegram getWebhookInfo.last_error_message: ${lastErr}`);
  }

  if (!info.result?.url) {
    hints.push(
      "No webhook URL registered. Call GET /api/telegram/set-webhook?secret=ADMIN_SETUP_SECRET once.",
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const expectedPath = base ? `${base}/api/telegram/webhook` : null;
  if (
    expectedPath &&
    info.result?.url &&
    info.result.url !== expectedPath
  ) {
    hints.push(
      `Webhook URL is "${info.result.url}" but NEXT_PUBLIC_APP_URL implies "${expectedPath}". Re-run set-webhook.`,
    );
  }

  return Response.json({
    ok: true,
    telegramGetMe: me,
    telegramGetWebhookInfo: info,
    env: {
      botHandlerReady: isBotConfigured(),
      hasNotionToken: Boolean(cfg.notionToken),
      hasNotionDatabaseId: Boolean(cfg.notionDatabaseId),
      hasTelegramToken: Boolean(cfg.telegramBotToken),
      nextPublicAppUrl: cfg.publicAppUrl || null,
      telegramWebhookSecretSet: Boolean(cfg.telegramWebhookSecret),
    },
    hints,
  });
}
