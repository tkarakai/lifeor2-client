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

/** Accept a named category or a category term; unknown merchant/category mappings need clarification. */
export function expenseCategoryReferenced(name: string, id: string, userPrompts: string[]): boolean {
  if (paymentAccountReferenced(name, id, userPrompts)) return true;
  const stem = (word: string) => word.endsWith("ies") ? word.slice(0, -3) + "y" : word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
  const words = (text: string) => text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem);
  // These identify expense concepts, not arbitrary identity words in account labels.
  const concepts = new Set(words("groceries utilities transportation medical dental subscriptions insurance dining entertainment school children maintenance fuel rent mortgage interest withholding benefits hosting software supplies registration contractors consulting travel office training tax taxes charity donations clothing repairs education groceries"));
  const terms = words(name).filter(w => concepts.has(w));
  return userPrompts.some(prompt => words(prompt).some(w => terms.includes(w)));
}
