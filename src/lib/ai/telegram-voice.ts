/**
 * Download a Telegram voice/audio file to an ArrayBuffer (for Whisper).
 * Uses getFile → https://api.telegram.org/file/bot<token>/<file_path>.
 */

const TELEGRAM_FILE_URL = "https://api.telegram.org";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_BYTES = 24 * 1024 * 1024;

export async function downloadTelegramFile(
  token: string,
  fileId: string,
): Promise<{ buffer: ArrayBuffer; filename: string; mimeType: string }> {
  const metaRes = await fetch(
    `${TELEGRAM_FILE_URL}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const metaText = await metaRes.text();
  if (!metaRes.ok) {
    throw new Error(`Telegram getFile failed: ${metaRes.status} ${metaText}`);
  }
  const meta = JSON.parse(metaText) as {
    ok?: boolean;
    result?: { file_path?: string; file_size?: number };
    description?: string;
  };
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error(
      `Telegram getFile rejected: ${meta.description ?? "no file_path"}`,
    );
  }
  if (meta.result.file_size && meta.result.file_size > MAX_BYTES) {
    throw new Error("Voice file exceeds 24MB.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const fileRes = await fetch(
      `${TELEGRAM_FILE_URL}/file/bot${token}/${meta.result.file_path}`,
      { signal: controller.signal },
    );
    if (!fileRes.ok) {
      throw new Error(`Telegram file download failed: HTTP ${fileRes.status}`);
    }
    const buffer = await fileRes.arrayBuffer();
    const filename = meta.result.file_path.split("/").pop() || "voice.oga";
    const mimeType =
      fileRes.headers.get("content-type") ?? "application/octet-stream";
    return { buffer, filename, mimeType };
  } finally {
    clearTimeout(timeout);
  }
}
