import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const bun = Bun.which("bun") ?? "bun";
const children: ReturnType<typeof Bun.spawn>[] = [];
// Product execution always goes through the real Chainlink CRE workflow.
// Disposable local chain tests own their nodes; dev never starts a direct signer.
process.env.ORIGINS_EXECUTION_MODE ??= "cre";
if (process.env.ORIGINS_EXECUTION_MODE !== "cre") {
  throw new Error("Woga supports CRE execution only. Unset ORIGINS_EXECUTION_MODE or set it to cre.");
}
children.push(
  Bun.spawn([bun, "run", "server/index.ts"], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn([bun, "run", "vite", "--host", "127.0.0.1"], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
console.log(
  "Woga · Chainlink CRE execution · canvas: http://127.0.0.1:5173 · backend: http://127.0.0.1:4318",
);
const firstExit = await Promise.race(
  children.map(async (child) => await child.exited),
);
await stop();
await Promise.all(children.map((child) => child.exited));
process.exitCode = firstExit;
