/** Preserve simple relative dates from the current original user request, never source/model text. */
export function calendarReferences(question: string) {
  question = question.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`|(?<!\w)'[^'\n]*'(?!\w)/g, " ");
  // Mixed origin/destination, negation and explicit-date clauses need the model
  // to choose the intended field; never silently rewrite those instructions.
  if (/\b(?:from|not|instead|rather|except|originally)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d/i.test(question)) return [];
  const number = "(?:\\d{1,4}|a|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)";
  const pattern = new RegExp(`\\b(?:(?:the )?day after tomorrow|(?:the )?day before yesterday|next (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|today|tomorrow|yesterday|in ${number} (?:days?|weeks?)|${number} (?:days?|weeks?) (?:later|earlier))\\b`, "gi");
  return [...new Set([...question.matchAll(pattern)].map(m => m[0].toLowerCase().replace(/\s+/g, " ")))];
}
export function preservingClockTime(question: string) {
  return /\bat the same time[.!?]?\s*$/i.test(question);
}
