import { test, expect } from "bun:test";
import { compactReply, replyBlocks } from "../src/reply-format";

test("compact captions preserve the outcome and keep table details in the expanded response", () => {
  const text = "The run completed without a pause.\n\nExact archived observations:\n\n| Market | Price | Observed at |\n| --- | ---: | --- |\n| SOL/USD | $118.57 | 2026-10-07T08:00:00Z |\n| ETH/USD | $2,615.66 | 2026-10-07T08:00:01Z |";
  expect(compactReply(text)).toBe("The run completed without a pause.");
  const table = replyBlocks(text).find(block => block.kind === "table")!;
  expect(table).toEqual({ kind: "table", headers: ["Market", "Price", "Observed at"], rows: [["SOL/USD", "$118.57", "2026-10-07T08:00:00Z"], ["ETH/USD", "$2,615.66", "2026-10-07T08:00:01Z"]] });
});

test("untrusted HTML remains literal text and is never a rendered instruction or element", () => {
  const text = "<script>alert('unsafe')</script>\n\n| Input | Value |\n| --- | --- |\n| <img src=x onerror=alert(1)> | `code` |";
  expect(replyBlocks(text)[0]).toEqual({ kind: "paragraph", text: "<script>alert('unsafe')</script>" });
  expect(replyBlocks(text)[1]).toEqual({ kind: "table", headers: ["Input", "Value"], rows: [["<img src=x onerror=alert(1)>", "`code`"]] });
});

test("escaped pipes stay inside cells and plain sentences with pipes remain intact", () => {
  expect(replyBlocks("| Label | Value |\n| --- | --- |\n| A\\|B | 7 |")[0]).toEqual({ kind: "table", headers: ["Label", "Value"], rows: [["A|B", "7"]] });
  expect(compactReply("A | B is an observation, not a Markdown table.")).toBe("A | B is an observation, not a Markdown table.");
});

test("table-only output remains accessible and long captions clearly indicate truncation", () => {
  expect(compactReply("| Source | Value |\n| --- | --- |\n| SOL | 118 |")).toBe("Response includes tabular details.");
  const long = "Source observations are archived with their exact timestamps. ".repeat(10);
  expect(compactReply(long).length).toBeLessThanOrEqual(220);
  expect(compactReply(long)).toEndWith("…");
  expect(replyBlocks(long)[0]).toEqual({ kind: "paragraph", text: long.trim() });
});
