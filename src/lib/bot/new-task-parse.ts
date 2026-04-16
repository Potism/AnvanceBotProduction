import type { NewTaskInput } from "../notion/actions";

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  thu: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
};

function todayUTCDate(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Accepts: ISO, today, tomorrow, +Nd, +Nw, weekday short/long. */
export function parseFriendlyDate(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;

  const t = todayUTCDate();
  if (s === "today") return t.toISOString().slice(0, 10);
  if (s === "tomorrow" || s === "tmr") {
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10);
  }

  const rel = s.match(/^\+(\d+)\s*(d|day|days|w|week|weeks)?$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? "d").startsWith("w") ? 7 : 1;
    t.setUTCDate(t.getUTCDate() + n * unit);
    return t.toISOString().slice(0, 10);
  }

  const key = s.slice(0, 4);
  const wd =
    WEEKDAYS[key] ?? WEEKDAYS[s.slice(0, 3)] ?? WEEKDAYS[s.slice(0, 2)];
  if (typeof wd === "number") {
    const current = t.getUTCDay();
    let add = (wd - current + 7) % 7;
    if (add === 0) add = 7;
    t.setUTCDate(t.getUTCDate() + add);
    return t.toISOString().slice(0, 10);
  }

  return null;
}

const KEY_ALIASES: Record<string, keyof NewTaskInput> = {
  client: "client",
  c: "client",
  deliv: "deliverable",
  deliverable: "deliverable",
  service: "serviceLine",
  line: "serviceLine",
  priority: "priority",
  prio: "priority",
  p: "priority",
  status: "status",
  due: "due",
  by: "due",
  deadline: "due",
  shoot: "shoot",
  live: "shoot",
  assign: "assignee",
  assignee: "assignee",
  to: "assignee",
  owner: "assignee",
};

/**
 * Parse `/new TITLE · key:value · key:value …` or pipe/semicolon separators.
 * If a value looks like a date (keyed or after "due "), it's treated as due.
 */
export function parseNewTaskArgs(raw: string): Partial<NewTaskInput> & {
  rawTokens: string[];
  unknown: string[];
} {
  const text = raw.trim();
  const tokens = text
    .split(/[·|;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: Partial<NewTaskInput> & { rawTokens: string[]; unknown: string[] } = {
    rawTokens: tokens,
    unknown: [],
  };
  if (tokens.length === 0) return out;

  out.title = tokens[0];

  for (const tok of tokens.slice(1)) {
    const kv = tok.match(/^([a-zA-Z]+)\s*[:=]\s*(.+)$/);
    if (kv) {
      const keyRaw = kv[1].toLowerCase();
      const value = kv[2].trim();
      const key = KEY_ALIASES[keyRaw];
      if (!key) {
        out.unknown.push(tok);
        continue;
      }
      if (key === "due" || key === "shoot") {
        const d = parseFriendlyDate(value);
        if (d) out[key] = d;
        else out.unknown.push(tok);
      } else if (key === "telegramUserId") {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) out.telegramUserId = n;
        else out.unknown.push(tok);
      } else {
        out[key] = value;
      }
      continue;
    }

    const d = parseFriendlyDate(tok);
    if (d) {
      if (!out.due) out.due = d;
      else if (!out.shoot) out.shoot = d;
      continue;
    }

    out.unknown.push(tok);
  }

  return out;
}
