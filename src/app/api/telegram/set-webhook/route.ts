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
  const whSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const reset = req.nextUrl.searchParams.get("reset") === "1";

  if (!token || !base) {
    return Response.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN and NEXT_PUBLIC_APP_URL required" },
      { status: 400 },
    );
  }

  if (whSecret && whSecret.length > 256) {
    return Response.json(
      {
        ok: false,
        error: "TELEGRAM_WEBHOOK_SECRET must be at most 256 characters for Telegram secret_token",
      },
      { status: 400 },
    );
  }

  if (reset) {
    const del = await fetch(
      `https://api.telegram.org/bot${token}/deleteWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drop_pending_updates: true }),
      },
    );
    const delBody = (await del.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (delBody.ok !== true) {
      return Response.json(
        {
          ok: false,
          step: "deleteWebhook",
          telegram: delBody,
          hint: delBody.description ?? "deleteWebhook failed",
        },
        { status: 502 },
      );
    }
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
        drop_pending_updates: reset ? true : undefined,
      }),
    },
  );

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
  };

  // Telegram often returns HTTP 200 with {"ok":false,"description":"..."} (invalid token, bad URL, etc.).
  const telegramAccepted = body.ok === true;
  const ok = res.ok && telegramAccepted;

  return Response.json(
    {
      ok,
      httpStatus: res.status,
      telegram: body,
      webhookUrl: url,
      resetUsed: reset,
      hint: telegramAccepted
        ? "Webhook registered. Re-check GET /api/telegram/status?secret=…"
        : body.description ??
          "Telegram rejected setWebhook. Fix description, then try again.",
    },
    { status: ok ? 200 : 502 },
  );
}
