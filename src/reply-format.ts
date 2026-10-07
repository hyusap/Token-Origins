export type ReplyBlock = { kind: "paragraph"; text: string } | { kind: "table"; headers: string[]; rows: string[][] };
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
const divider = (line: string) => cells(line).every(cell => /^:?-{3,}:?$/.test(cell));

/** Treat model output as text; the renderer never evaluates HTML or code. */
export function replyBlocks(text: string): ReplyBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ReplyBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n").trim() }); paragraph = []; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.includes("|") && index + 1 < lines.length && divider(lines[index + 1]!)) {
      flush();
      const headers = cells(line), rows: string[][] = [];
      index++;
      while (index + 1 < lines.length && lines[index + 1]!.includes("|") && lines[index + 1]!.trim()) rows.push(cells(lines[++index]!));
      blocks.push({ kind: "table", headers, rows });
    } else if (!line.trim()) flush();
    else paragraph.push(line.replace(/^#{1,6}\s+/, ""));
  }
  flush();
  return blocks;
}

export function compactReply(text: string): string {
  const paragraphs = replyBlocks(text).filter((block): block is Extract<ReplyBlock, { kind: "paragraph" }> => block.kind === "paragraph");
  const narrative = paragraphs[0]?.text.replace(/\n/g, " ").replace(/\*\*/g, "").replace(/`/g, "").trim();
  if (!narrative) return text.trim() ? "Response includes tabular details." : "";
  if (replyBlocks(text).some(block => block.kind === "table")) {
    const sentence = narrative.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
    if (sentence) return sentence;
  }
  if (narrative.length <= 220) return narrative;
  return narrative.slice(0, 217).replace(/\s+\S*$/, "") + "…";
}
