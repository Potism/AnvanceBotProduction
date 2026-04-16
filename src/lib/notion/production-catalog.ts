import type { BotConfig } from "../types";
import { fetchProductionPages } from "./tasks";
import { propertyAsString } from "./props";

export type ProductionCatalog = {
  clients: string[];
  deliverables: string[];
  assignees: string[];
};

/** Distinct values from open Production rows for wizard pickers (5-min cache). */
let cached: { at: number; value: ProductionCatalog; key: string } | null = null;
const TTL_MS = 5 * 60_000;

export async function loadProductionCatalog(
  cfg: BotConfig,
): Promise<ProductionCatalog> {
  const key = `${cfg.notionDatabaseId}`;
  if (cached && cached.key === key && Date.now() - cached.at < TTL_MS) {
    return cached.value;
  }

  const pages = await fetchProductionPages(cfg, "board");
  const props = cfg.notionProps;
  const clients = new Set<string>();
  const deliverables = new Set<string>();
  const assignees = new Set<string>();

  for (const page of pages) {
    const c = propertyAsString(page, props.client).trim();
    if (c) clients.add(c);
    const d = propertyAsString(page, props.deliverable).trim();
    if (d) deliverables.add(d);
    const a = propertyAsString(page, props.assignee).trim();
    if (a) assignees.add(a);
  }

  const sorted = (s: Set<string>) =>
    [...s].sort((a, b) => a.localeCompare(b));

  const value = {
    clients: sorted(clients),
    deliverables: sorted(deliverables),
    assignees: sorted(assignees),
  };
  cached = { at: Date.now(), value, key };
  return value;
}

export function clearProductionCatalogCache(): void {
  cached = null;
}
