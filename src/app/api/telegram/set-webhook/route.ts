import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = req.nextUrl.searchParams.get("secret");
  if (!admin || admin !== process.env.ADMIN_SETUP_SECRET) {
    return new Response("Not found", { status: 404 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const whSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token || !base) {
    return Response.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN and NEXT_PUBLIC_APP_URL required" },
      { status: 400 },
    );
  }

  const url = `${base}/api/telegram/webhook`;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        secret_token: whSecret || undefined,
        allowed_updates: ["message", "callback_query"],
      }),
    },
  );

  const body = await res.json().catch(() => ({}));
  return Response.json({ ok: res.ok, telegram: body, webhookUrl: url });
}
