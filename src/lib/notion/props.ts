import type {
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";

export function plainFromRichText(items: RichTextItemResponse[]): string {
  return items.map((i) => i.plain_text).join("").trim();
}

export function propertyAsLines(
  page: PageObjectResponse,
  propName: string,
): string[] {
  const p = page.properties[propName];
  if (!p) return [];

  switch (p.type) {
    case "title":
      return [plainFromRichText(p.title)].filter(Boolean);
    case "rich_text":
      return [plainFromRichText(p.rich_text)].filter(Boolean);
    case "select":
      return p.select?.name ? [p.select.name] : [];
    case "multi_select":
      return p.multi_select.map((m) => m.name).filter(Boolean);
    case "status":
      return p.status?.name ? [p.status.name] : [];
    case "date": {
      const s = p.date?.start;
      if (!s) return [];
      return [s];
    }
    case "people":
      return p.people
        .map((person) => {
          if ("name" in person && typeof person.name === "string") {
            return person.name;
          }
          return "";
        })
        .filter(Boolean);
    case "url":
      return p.url ? [p.url] : [];
    case "number":
      return p.number != null ? [String(p.number)] : [];
    case "formula": {
      const f = p.formula;
      if (f.type === "string") return f.string ? [f.string] : [];
      if (f.type === "number" && f.number != null) return [String(f.number)];
      if (f.type === "boolean") return [String(f.boolean)];
      if (f.type === "date" && f.date?.start) return [f.date.start];
      return [];
    }
    case "rollup":
      return [];
    default:
      return [];
  }
}

/** People-type assignee: partial user refs (for email enrichment on /link). */
export function propertyPeopleRefs(
  page: PageObjectResponse,
  propName: string,
): { id: string; name: string }[] {
  const p = page.properties[propName];
  if (!p || p.type !== "people") return [];
  return p.people
    .filter((u) => "id" in u && typeof u.id === "string")
    .map((u) => ({
      id: u.id,
      name: "name" in u && typeof u.name === "string" ? u.name : "",
    }));
}

export function propertyAsString(
  page: PageObjectResponse,
  propName: string,
): string {
  return propertyAsLines(page, propName).join(", ");
}

export function pageTitle(page: PageObjectResponse, nameProp: string): string {
  const p = page.properties[nameProp];
  if (p?.type === "title") return plainFromRichText(p.title) || "Untitled";
  return "Untitled";
}

/** First non-empty title property on the page (any column name). */
export function firstTitleOnPage(page: PageObjectResponse): string {
  for (const p of Object.values(page.properties)) {
    if (p?.type === "title") {
      const t = plainFromRichText(p.title).trim();
      if (t) return t;
    }
  }
  return "";
}
