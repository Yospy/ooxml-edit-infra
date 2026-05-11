export function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function escapeHtml(value: string): string {
  return escapeXml(value);
}

export function attr(block: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(block);
  return match?.[1];
}

export function numberAttr(block: string, name: string): number | undefined {
  const value = attr(block, name);
  return value === undefined ? undefined : Number(value);
}
