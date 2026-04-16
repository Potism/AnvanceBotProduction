/**
 * Minimal OpenAI client: voice transcription, structured task extraction,
 * and a single intent router for free-form messages.
 * Enabled whenever OPENAI_API_KEY is present.
 */

const OPENAI_DIRECT = "https://api.openai.com/v1";
const VERCEL_GATEWAY = "https://ai-gateway.vercel.sh/v1";

const CHAT_TIMEOUT_MS = 30_000;
const AUDIO_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

function apiKey(): string {
  return process.env.OPENAI_API_KEY?.trim() ?? "";
}

function isGatewayKey(key: string): boolean {
  return key.startsWith("vck_") || key.startsWith("ai_");
}

/** Base URL for chat completions. Auto-routes Vercel Gateway keys. */
function chatBaseUrl(): string {
  const explicit = process.env.OPENAI_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return isGatewayKey(apiKey()) ? VERCEL_GATEWAY : OPENAI_DIRECT;
}

/** Audio base URL — Whisper is NOT served via Vercel AI Gateway (yet),
 *  so gateway keys are not used for audio. An explicit override wins. */
function audioBaseUrl(): string {
  const explicit =
    process.env.OPENAI_AUDIO_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return OPENAI_DIRECT;
}

function audioKey(): string {
  return (
    process.env.OPENAI_AUDIO_KEY?.trim() ||
    (isGatewayKey(apiKey()) ? "" : apiKey())
  );
}

export function aiEnabled(): boolean {
  return Boolean(apiKey());
}

export function voiceEnabled(): boolean {
  return Boolean(audioKey());
}

/** Chat model. On Vercel Gateway, prefer provider-prefixed slug (openai/…). */
function chatModel(): string {
  const m = process.env.OPENAI_MODEL?.trim();
  if (m) return m;
  return isGatewayKey(apiKey()) ? "openai/gpt-5.4" : "gpt-5.4";
}

function audioModel(): string {
  return process.env.OPENAI_AUDIO_MODEL?.trim() || "whisper-1";
}

function todayISO(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function timedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? CHAT_TIMEOUT_MS,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Transcribe an audio buffer (Telegram voice .oga/.ogg) via OpenAI audio model. */
export async function transcribeAudio(
  audio: ArrayBuffer,
  filename: string,
): Promise<string> {
  if (!voiceEnabled()) {
    throw new Error(
      "Voice transcription needs a raw OpenAI key. Your OPENAI_API_KEY looks like a Vercel AI Gateway token (vck_…), which currently doesn't expose Whisper. Add OPENAI_AUDIO_KEY=sk-... (or set OPENAI_API_KEY directly to an sk- key).",
    );
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error("Audio too large (max 24MB).");
  }

  const form = new FormData();
  form.append("file", new Blob([audio]), filename || "voice.ogg");
  form.append("model", audioModel());
  form.append("response_format", "json");
  form.append("temperature", "0");

  const url = `${audioBaseUrl()}/audio/transcriptions`;
  const res = await timedFetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${audioKey()}` },
    body: form,
    timeoutMs: AUDIO_TIMEOUT_MS,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI transcription failed: ${res.status} ${text}`);
  }
  const data = JSON.parse(text) as { text?: string };
  return (data.text ?? "").trim();
}

async function chatJson<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  schemaName: string,
): Promise<T> {
  if (!aiEnabled()) throw new Error("OPENAI_API_KEY not set");

  const body = {
    model: chatModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true,
        schema,
      },
    },
  };

  const res = await timedFetch(`${chatBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI chat failed: ${res.status} ${text}`);
  }

  const data = JSON.parse(text) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("OpenAI returned empty content");
  return JSON.parse(content) as T;
}

// ── Task extraction ──────────────────────────────────────────────────────────

export type ExtractedTask = {
  title: string;
  client: string;
  deliverable: string;
  priority: string;
  due: string;
  shoot: string;
  assignee: string;
  missing: string[];
  confidence: "high" | "medium" | "low";
};

const TASK_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    client: { type: "string" },
    deliverable: { type: "string" },
    priority: { type: "string" },
    due: { type: "string", description: "ISO yyyy-mm-dd or empty" },
    shoot: { type: "string", description: "ISO yyyy-mm-dd or empty" },
    assignee: { type: "string" },
    missing: {
      type: "array",
      items: { type: "string" },
      description: "Fields the user didn't specify and that might be worth asking about",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "title",
    "client",
    "deliverable",
    "priority",
    "due",
    "shoot",
    "assignee",
    "missing",
    "confidence",
  ],
};

export type ExtractionContext = {
  knownClients: string[];
  knownAssignees: string[];
  knownDeliverables: string[];
  knownPriorities: string[];
  knownStatuses: string[];
};

export async function extractNewTask(
  userText: string,
  ctx: ExtractionContext,
): Promise<ExtractedTask> {
  const system = [
    `You extract structured production-task fields from a short message or voice transcript.`,
    `Today is ${todayISO()} (UTC). Interpret relative dates ("Friday", "tomorrow", "in 2 days") against today.`,
    `Return empty string for fields you cannot infer — never hallucinate values.`,
    `Priority must be one of the known priorities when the user implies urgency (e.g. "P1", "rush", "urgent" → the P1-like option).`,
    `Client and deliverable: snap to the closest match from the known lists when the user clearly refers to one.`,
    `Title is a short imperative noun phrase (e.g. "Reels pack for APX", not a sentence).`,
    `"missing" should list any high-signal field the user didn't specify (from: due, shoot, client, deliverable, assignee).`,
  ].join(" ");

  const user = [
    `Message: """${userText.replace(/"/g, '\\"')}"""`,
    ``,
    `Known clients: ${ctx.knownClients.slice(0, 30).join(" | ") || "(none)"}`,
    `Known assignees: ${ctx.knownAssignees.slice(0, 30).join(" | ") || "(none)"}`,
    `Known deliverables: ${ctx.knownDeliverables.slice(0, 30).join(" | ") || "(none)"}`,
    `Known priorities: ${ctx.knownPriorities.join(" | ") || "(none)"}`,
    `Known statuses: ${ctx.knownStatuses.join(" | ") || "(none)"}`,
  ].join("\n");

  return chatJson<ExtractedTask>(system, user, TASK_SCHEMA, "new_task");
}

// ── Intent router ────────────────────────────────────────────────────────────

export type RouterIntent =
  | { kind: "view"; view: "today" | "week" | "mine" | "overdue" | "board" }
  | { kind: "find"; query: string }
  | { kind: "create"; transcriptForExtractor: string }
  | { kind: "reviews" }
  | { kind: "shoots" }
  | { kind: "help" }
  | { kind: "smalltalk"; reply: string };

type RouterResponse = {
  kind:
    | "view"
    | "find"
    | "create"
    | "reviews"
    | "shoots"
    | "help"
    | "smalltalk";
  view: string;
  query: string;
  transcriptForExtractor: string;
  reply: string;
};

const INTENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["view", "find", "create", "reviews", "shoots", "help", "smalltalk"],
    },
    view: { type: "string" },
    query: { type: "string" },
    transcriptForExtractor: { type: "string" },
    reply: { type: "string" },
  },
  required: ["kind", "view", "query", "transcriptForExtractor", "reply"],
};

export async function routeIntent(userText: string): Promise<RouterIntent> {
  const system = [
    `You classify short Telegram messages for a production-task bot.`,
    `Pick exactly one intent:`,
    `- view: user wants a list. Set "view" to one of: today | week | mine | overdue | board.`,
    `- find: user wants to search for a task. Put the keyword(s) in "query".`,
    `- create: user wants to create a new task. Copy the full message into "transcriptForExtractor".`,
    `- reviews: user wants tasks they're reviewing (approver).`,
    `- shoots: user wants upcoming shoots/live dates.`,
    `- help: user asks what the bot can do.`,
    `- smalltalk: greetings, thanks, ambiguous. Put a short warm reply (≤20 words) in "reply".`,
    `Always fill every field — use empty string if unused.`,
  ].join(" ");

  const r = await chatJson<RouterResponse>(
    system,
    `Message: """${userText.replace(/"/g, '\\"')}"""`,
    INTENT_SCHEMA,
    "intent",
  );

  if (r.kind === "view") {
    const v = r.view as RouterIntent extends { kind: "view"; view: infer V }
      ? V
      : never;
    const allowed = ["today", "week", "mine", "overdue", "board"] as const;
    if ((allowed as readonly string[]).includes(v)) {
      return { kind: "view", view: v };
    }
    return { kind: "help" };
  }
  if (r.kind === "find") return { kind: "find", query: r.query };
  if (r.kind === "create") {
    return {
      kind: "create",
      transcriptForExtractor: r.transcriptForExtractor || userText,
    };
  }
  if (r.kind === "reviews") return { kind: "reviews" };
  if (r.kind === "shoots") return { kind: "shoots" };
  if (r.kind === "help") return { kind: "help" };
  return { kind: "smalltalk", reply: r.reply || "On it." };
}

// ── Date normalization ───────────────────────────────────────────────────────

type DateResponse = { iso: string; confidence: number; note: string };

const DATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    iso: { type: "string" },
    confidence: { type: "number" },
    note: { type: "string" },
  },
  required: ["iso", "confidence", "note"],
};

/** Normalize any human date phrase into an ISO yyyy-mm-dd.
 *  Returns null if the model is unsure or the input doesn't look like a date.
 *  `todayISO` gives the LLM a stable reference so "tomorrow" / "friday" resolve
 *  to the right week. */
export async function aiParseDate(
  input: string,
  todayISO: string,
): Promise<string | null> {
  if (!aiEnabled()) return null;
  const phrase = input.trim();
  if (!phrase) return null;
  try {
    const system = [
      `You normalize human date phrases to ISO yyyy-mm-dd.`,
      `Use "${todayISO}" as today.`,
      `Weekdays default to the upcoming one (if today is the weekday, return today).`,
      `"next <weekday>" = the one in the following week (7+ days away).`,
      `"end of month" = last day of the current month.`,
      `"end of week" = the upcoming Sunday.`,
      `Relative like "in 3 weeks", "+5d" are supported.`,
      `If ambiguous or not a date, set iso="" and confidence=0.`,
      `Return iso in yyyy-mm-dd only (no time). confidence 0..1. note: short reason.`,
    ].join(" ");
    const r = await chatJson<DateResponse>(
      system,
      `Phrase: """${phrase.replace(/"/g, '\\"')}"""`,
      DATE_SCHEMA,
      "date_normalize",
    );
    if (!r.iso) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.iso)) return null;
    if (r.confidence < 0.5) return null;
    return r.iso;
  } catch (e) {
    console.warn("[ai date]", (e as Error).message);
    return null;
  }
}
