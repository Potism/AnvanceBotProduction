import { Client } from "@notionhq/client";
import type { UserObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import type { BotConfig } from "../types";
import { propertyAsString, propertyPeopleRefs } from "./props";
import { fetchProductionPages } from "./tasks";

export type AssigneeLinkCatalog = {
  /** Display strings from task rows (text, People names joined, etc.) */
  displayNames: string[];
  /** Lowercased workspace email → display name for /mine (from Notion Users API) */
  emailToDisplay: Record<string, string>;
};

function personEmailFromUser(u: UserObjectResponse): string | null {
  if (u.type !== "person" || !("person" in u) || !u.person) return null;
  const pe = u.person as { email?: string };
  if (typeof pe.email !== "string" || !pe.email.includes("@")) return null;
  return pe.email.trim().toLowerCase();
}

/**
 * Names (and optional workspace emails) that can be used with /link for People-type Assignee.
 */
export async function loadAssigneeLinkCatalog(
  cfg: BotConfig,
): Promise<AssigneeLinkCatalog> {
  const pages = await fetchProductionPages(cfg, "board");
  const assigneeProp = cfg.notionProps.assignee;
  const displayNames = new Set<string>();
  const userIds = new Set<string>();

  for (const page of pages) {
    const s = propertyAsString(page, assigneeProp).trim();
    if (s) displayNames.add(s);
    for (const { id } of propertyPeopleRefs(page, assigneeProp)) {
      userIds.add(id);
    }
  }

  const emailToDisplay: Record<string, string> = {};
  const client = new Client({ auth: cfg.notionToken });

  for (const uid of userIds) {
    try {
      const u = (await client.users.retrieve({
        user_id: uid,
      })) as UserObjectResponse;
      const email = personEmailFromUser(u);
      const display =
        "name" in u && typeof u.name === "string" && u.name.trim()
          ? u.name.trim()
          : "";
      if (email && display) {
        emailToDisplay[email] = display;
        displayNames.add(display);
      }
    } catch {
      /* bot, removed user, or no access */
    }
  }

  return {
    displayNames: [...displayNames].sort((a, b) => a.localeCompare(b)),
    emailToDisplay,
  };
}

export type AssigneeMatchResult =
  | { ok: true; assignee: string; mode: "exact" | "unique_partial" | "email" }
  | { ok: false; reason: "empty" | "none" | "ambiguous"; suggestions: string[] };

function matchOnDisplayNames(
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

/**
 * Map /link input to the assignee string used for My queue (matches People names on tasks).
 */
export function matchAssigneeInput(
  raw: string,
  catalog: AssigneeLinkCatalog,
): AssigneeMatchResult {
  const t = raw.trim();
  if (!t) return { ok: false, reason: "empty", suggestions: [] };

  if (t.includes("@")) {
    const key = t.toLowerCase();
    if (catalog.emailToDisplay[key]) {
      return {
        ok: true,
        assignee: catalog.emailToDisplay[key],
        mode: "email",
      };
    }
  }

  return matchOnDisplayNames(t, catalog.displayNames);
}
