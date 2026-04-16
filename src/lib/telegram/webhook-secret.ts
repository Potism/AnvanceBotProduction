/**
 * Telegram setWebhook `secret_token` rules (Bot API):
 * 1–256 chars, only [A-Za-z0-9_-]. No colons — bot tokens are invalid here.
 */
const SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function isValidTelegramWebhookSecretToken(raw: string | undefined): boolean {
  const s = raw?.trim();
  if (!s) return false;
  return SECRET_TOKEN_PATTERN.test(s);
}

export function telegramWebhookSecretTokenIssue(
  raw: string | undefined,
): string | null {
  const s = raw?.trim();
  if (!s) return null;
  if (s.length > 256) {
    return "TELEGRAM_WEBHOOK_SECRET must be at most 256 characters.";
  }
  if (!SECRET_TOKEN_PATTERN.test(s)) {
    return (
      "TELEGRAM_WEBHOOK_SECRET may only use A–Z, a–z, 0–9, underscore (_), hyphen (-). " +
      "It cannot be your bot token (those contain ':'). Generate e.g. openssl rand -hex 32, " +
      "set it in Vercel, redeploy, then call set-webhook again."
    );
  }
  return null;
}
