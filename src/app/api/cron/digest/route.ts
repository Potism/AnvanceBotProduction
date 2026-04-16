import { NextRequest } from "next/server";
import { getBotConfig, isBotConfigured } from "@/lib/config";
import { sendMorningDigest } from "@/lib/bot/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_TZ = "Europe/Rome";
const DEFAULT_HOUR = 8;

function currentHourInTz(tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const h = parts.find((p) => p.type === "hour")?.value ?? "";
    const n = Number.parseInt(h, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Morning digest for every linked teammate.
 *
 * Triggered by Vercel Cron (Authorization: Bearer <CRON_SECRET>) at two UTC
 * slots (06:00 and 07:00). We only run when the local hour in the configured
 * timezone equals the configured digest hour (defaults to Europe/Rome 08:00),
 * which auto-corrects across CET↔CEST.
 *
 * Manual runs with ?secret=ADMIN_SETUP_SECRET always run regardless of hour.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const adminParam = req.nextUrl.searchParams.get("secret");
  const adminSecret = process.env.ADMIN_SETUP_SECRET;

  const cronAuthed = Boolean(cronSecret && auth === `Bearer ${cronSecret}`);
  const manualAuthed = Boolean(
    adminParam && adminSecret && adminParam === adminSecret,
  );
  const vercelCron = req.headers.get("x-vercel-cron") !== null;

  if (!cronAuthed && !manualAuthed && !vercelCron) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!isBotConfigured()) {
    return Response.json(
      { ok: false, error: "bot not configured" },
      { status: 503 },
    );
  }

  const tz = process.env.TELEGRAM_DIGEST_TZ?.trim() || DEFAULT_TZ;
  const hourEnv = process.env.TELEGRAM_DIGEST_HOUR?.trim();
  const targetHour =
    hourEnv && /^\d+$/.test(hourEnv)
      ? Number.parseInt(hourEnv, 10)
      : DEFAULT_HOUR;

  if (!manualAuthed) {
    const h = currentHourInTz(tz);
    if (h !== targetHour) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: `Not ${targetHour}:00 in ${tz} yet (currently hour=${h}).`,
      });
    }
  }

  try {
    const result = await sendMorningDigest(getBotConfig());
    return Response.json({ ok: true, tz, targetHour, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron digest]", e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
