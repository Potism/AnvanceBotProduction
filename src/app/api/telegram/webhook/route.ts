import { handleTelegramUpdate } from "@/lib/bot/handler";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = req.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      console.warn(
        "[telegram webhook] 403: X-Telegram-Bot-Api-Secret-Token mismatch or missing. Align TELEGRAM_WEBHOOK_SECRET in Vercel with setWebhook secret_token (or clear both).",
      );
      return new Response("Forbidden", { status: 403 });
    }
  }

  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  try {
    await handleTelegramUpdate(update);
  } catch (e) {
    console.error(
      "[telegram webhook] handler error (user may see no reply):",
      e,
    );
  }

  return new Response("OK", { status: 200 });
}

export async function GET() {
  return Response.json({
    ok: true,
    hint: "Telegram sends POST updates to this URL.",
  });
}
