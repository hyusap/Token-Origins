/** Technical observations remain intact in the price cards and inspector. */
export function displayReply(text: string): string {
  if (text === "Codex is interpreting the instruction" || text.startsWith("Codex is interpreting the utterance") || text.startsWith("Codex → ")) return "";
  if (!text.startsWith("Discovered ")) return text;
  const observations = [...text.matchAll(/([A-Z0-9]+) \/ USD: \$(\d+(?:\.\d+)?) \([^)]*, observed [^)]*\)/g)];
  if (!observations.length || text !== `Discovered ${observations.map(match => match[0]).join("; ")}.`) return text;
  const names: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana" };
  return observations.map(([, symbol, price]) => `${names[symbol!] || symbol} is ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(price))}.`).join(" ");
}
