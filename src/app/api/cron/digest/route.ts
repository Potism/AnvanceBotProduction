import { NextRequest } from "next/server";
import { getBotConfig, isBotConfigured } from "@/lib/config";
import { sendMorningDigest } from "@/lib/bot/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Morning digest for every linked teammate.
 * Triggered by Vercel Cron (automatic Authorization: Bearer <CRON_SECRET> header)
 * or manually with ?secret=ADMIN_SETUP_SECRET for testing.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const adminParam = req.nextUrl.searchParams.get("secret");
  const adminSecret = process.env.ADMIN_SETUP_SECRET;

  const cronAuthed = Boolean(
    cronSecret && auth === `Bearer ${cronSecret}`,
  );
  const manualAuthed = Boolean(
    adminParam && adminSecret && adminParam === adminSecret,
  );

  if (!cronAuthed && !manualAuthed) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!isBotConfigured()) {
    return Response.json(
      { ok: false, error: "bot not configured" },
      { status: 503 },
    );
  }

  try {
    const result = await sendMorningDigest(getBotConfig());
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron digest]", e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
