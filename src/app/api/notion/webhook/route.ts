import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { getBotConfig, isBotConfigured } from "@/lib/config";
import { notifyFromNotionEvent } from "@/lib/bot/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Last verification_token from Notion (same isolate; best-effort on serverless). */
const notionSetup = globalThis as typeof globalThis & {
  __notionLastVerificationToken?: string;
  __notionLastVerificationAt?: number;
};

/** Notion's one-time subscription verification body shape. */
function isVerificationOnlyPayload(
  body: unknown,
): body is { verification_token: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const o = body as Record<string, unknown>;
  const keys = Object.keys(o);
  return (
    keys.length === 1 &&
    keys[0] === "verification_token" &&
    typeof o.verification_token === "string"
  );
}

function verifyNotionSignature(
  rawBody: string,
  verificationToken: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const theirs = signatureHeader.slice("sha256=".length);
  const ours = createHmac("sha256", verificationToken)
    .update(rawBody, "utf8")
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(ours, "hex"), Buffer.from(theirs, "hex"));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (isVerificationOnlyPayload(parsed)) {
    const { verification_token } = parsed;
    notionSetup.__notionLastVerificationToken = verification_token;
    notionSetup.__notionLastVerificationAt = Date.now();
    console.info(
      "[notion webhook] Paste verification_token in Notion → Webhooks → Verify:",
      verification_token,
    );
    // Same value Notion sent in the request body; echoed so it can appear under
    // this invocation’s Response in Vercel when request logs omit console output.
    return Response.json({
      ok: true,
      verification_token,
      hint: "Copy verification_token into Notion’s Verify subscription dialog.",
    });
  }

  const token = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
  const sig = req.headers.get("x-notion-signature");

  if (token) {
    if (!verifyNotionSignature(rawBody, token, sig)) {
      return new Response("Forbidden", { status: 403 });
    }
  } else if (sig) {
    console.warn(
      "[notion webhook] Set NOTION_WEBHOOK_VERIFICATION_TOKEN to validate X-Notion-Signature",
    );
  }

  if (parsed && typeof parsed === "object" && "type" in parsed) {
    const evt = parsed as {
      type?: string;
      entity?: { id?: string; type?: string };
      data?: { parent?: { id?: string; type?: string } };
    };
    const type = evt.type ?? "";
    const pageId =
      evt.entity?.type === "page" ? evt.entity?.id ?? "" : "";
    console.info("[notion webhook] event", type, "page", pageId || "-");

    if (pageId && type.startsWith("page.") && isBotConfigured()) {
      notifyFromNotionEvent(getBotConfig(), type, pageId).catch((e) =>
        console.warn("[notion webhook] notify failed", (e as Error).message),
      );
    }
  }

  return Response.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const admin = req.nextUrl.searchParams.get("secret");
  if (admin && admin === process.env.ADMIN_SETUP_SECRET) {
    const token = notionSetup.__notionLastVerificationToken;
    const at = notionSetup.__notionLastVerificationAt;
    if (token) {
      return Response.json({
        ok: true,
        verification_token: token,
        received_at_ms: at,
        hint: "Paste verification_token into Notion → Verify subscription. If empty next time, click Resend in Notion then open this URL again (same browser tab is fine).",
      });
    }
    return Response.json(
      {
        ok: false,
        hint: "No token in memory yet. In Notion: Resend token, wait ~5s, refresh this page. If it stays empty, open Vercel logs for the POST /api/notion/webhook row (token is in the JSON response body there).",
      },
      { status: 404 },
    );
  }

  return Response.json({
    ok: true,
    hint: "Notion POSTs here for verification and events. After Notion sends the token, open GET with ?secret=ADMIN_SETUP_SECRET (same value as Telegram set-webhook) to read the last verification_token from this server instance.",
  });
}
