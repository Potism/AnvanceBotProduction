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
