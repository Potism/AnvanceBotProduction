import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    console.info(
      "[notion webhook] Paste this verification_token in Notion → Webhooks → Verify:",
      parsed.verification_token,
    );
    return Response.json({ ok: true });
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
    const t = (parsed as { type?: string }).type;
    console.info("[notion webhook] event", t);
  }

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({
    ok: true,
    hint: "Notion POSTs here for subscription verification and workspace events.",
  });
}
