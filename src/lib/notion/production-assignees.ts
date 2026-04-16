import type { BotConfig } from "../types";
import { fetchProductionTasks } from "./tasks";

/** Distinct non-empty Assignee strings from Production (board view, full window). */
export async function listDistinctAssigneesFromProduction(
  cfg: BotConfig,
): Promise<string[]> {
  const rows = await fetchProductionTasks(cfg, "board", undefined);
  const set = new Set<string>();
  for (const r of rows) {
    const a = r.assignee.trim();
    if (a) set.add(a);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export type AssigneeMatchResult =
  | { ok: true; assignee: string; mode: "exact" | "unique_partial" }
  | { ok: false; reason: "empty" | "none" | "ambiguous"; suggestions: string[] };

/**
 * Map free-text input to a canonical Production assignee string.
 */
export function matchAssigneeInput(
  raw: string,
  candidates: readonly string[],
): AssigneeMatchResult {
  const t = raw.trim();
  if (!t) return { ok: false, reason: "empty", suggestions: [] };

  const lower = t.toLowerCase();
  for (const a of candidates) {
    if (a.trim().toLowerCase() === lower) {
      return { ok: true, assignee: a, mode: "exact" };
    }
  }

  const partial = candidates.filter(
    (a) =>
      a.toLowerCase().includes(lower) || lower.includes(a.toLowerCase()),
  );
  if (partial.length === 1) {
    return { ok: true, assignee: partial[0], mode: "unique_partial" };
  }
  if (partial.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      suggestions: [...partial].sort((a, b) => a.localeCompare(b)).slice(0, 10),
    };
  }

  return {
    ok: false,
    reason: "none",
    suggestions: [...candidates].slice(0, 15),
  };
}
