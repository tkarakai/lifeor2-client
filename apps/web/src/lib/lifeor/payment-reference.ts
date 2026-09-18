/** A necessary reference check, not a substitute for interpreting user intent. */
export function paymentAccountReferenced(name: string, id: string, userPrompts: string[]): boolean {
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const label = normalize(name.replace(/\s*[·#]\s*\d{4,}\s*$/, ""));
  const identifier = name.match(/[·#]\s*(\d{4,})\s*$/)?.[1];
  return userPrompts.some(prompt => {
    const text = ` ${normalize(prompt)} `;
    if (text.includes(` ${normalize(id)} `) || (label && text.includes(` ${label} `))) return true;
    if (!identifier) return false;
    const words = text.trim().split(/\s+/);
    return words.some((word, i) => word === identifier && words.slice(Math.max(0, i - 4), i).some(w => ["account", "checking", "savings", "card"].includes(w)));
  });
}
