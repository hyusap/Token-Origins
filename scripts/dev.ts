import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localStatePath,
  validateLocalStateFile,
  snapshotLocalChain,
} from "./snapshot-local";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** How far behind real time the newest block in the saved snapshot sits. */
async function savedStateDriftSeconds(): Promise<number> {
  try {
    const state = await Bun.file(localStatePath).json();
    const blocks = state.blocks;
    const newest = Array.isArray(blocks) ? blocks[blocks.length - 1] : null;
    const raw = newest?.header?.timestamp;
    const seconds =
      typeof raw === "string" ? Number.parseInt(raw, 16) : Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.floor(Date.now() / 1000) - seconds;
  } catch {
    return 0;
  }
}
const bun = Bun.which("bun") ?? "bun";
const children: ReturnType<typeof Bun.spawn>[] = [];
let ownsLocalAnvil = false;
if (process.env.ORIGINS_EXECUTION_MODE !== "cre") {
  const rpc = "http://127.0.0.1:8545";
  async function rpcCall(method: string, params: unknown[] = []) {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(1500),
    });
    return (await response.json()) as any;
  }
  let startedAnvil = false;
  let chain: any;
  try {
    chain = await rpcCall("eth_chainId");
  } catch {}
  if (!chain) {
    const anvil = Bun.which("anvil");
    if (!anvil)
      throw new Error(
        "Local rehearsal needs Foundry Anvil. Install Foundry, then run bun run dev.",
      );
    if (await Bun.file(localStatePath).exists()) {
      await validateLocalStateFile();
      // Anvil restores the saved chain's clock along with its state, and keeps
      // lagging afterwards even if the clock is pushed forward. Once the saved
      // chain is further behind than the receiver's own report age, a freshly
      // observed price reads as future-dated and every delivery reverts
      // StaleObservation. Set that snapshot aside and start clean rather than
      // rehearse against a chain whose clock cannot be trusted.
      const drift = await savedStateDriftSeconds();
      if (drift > 120) {
        const aside = `${localStatePath}.stale-${Date.now()}`;
        await Bun.$`mv ${localStatePath} ${aside}`.quiet();
        await Bun.$`rm -f ${localStatePath}.metadata.json`.quiet();
        console.log(
          `Saved local chain was ${drift}s behind real time; started a clean chain and kept the old snapshot at ${aside}.`,
        );
      }
    }
    children.push(
      Bun.spawn(
        [
          anvil,
          "--host",
          "127.0.0.1",
          "--port",
          "8545",
          "--chain-id",
          "31337",
          "--state",
          localStatePath,
          "--state-interval",
          "5",
          "--preserve-historical-states",
          "--no-cors",
          "--silent",
        ],
        { cwd: root, stdout: "inherit", stderr: "inherit" },
      ),
    );
    startedAnvil = true;
    ownsLocalAnvil = true;
    for (let attempt = 0; attempt < 25 && !chain; attempt++) {
      await Bun.sleep(200);
      try {
        chain = await rpcCall("eth_chainId");
      } catch {}
    }
  }
  if (chain?.result !== "0x7a69")
    throw new Error("Refusing local setup: localhost RPC is not chain 31337.");
  let deployed = false;
  try {
    const metadata = await Bun.file(
      resolve(root, "contracts/deployment.local.json"),
    ).json();
    const code = await rpcCall("eth_getCode", [metadata.address, "latest"]);
    deployed =
      metadata.chainId === 31337 &&
      metadata.rpcUrl === rpc &&
      code.result &&
      code.result !== "0x";
  } catch {}
  if (!deployed) {
    const deploy = Bun.spawn([bun, "run", "scripts/deploy-local.ts"], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await deploy.exited) !== 0)
      throw new Error("Local vault deployment failed.");
  }
  if (startedAnvil) await snapshotLocalChain();
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
  if (ownsLocalAnvil) {
    try {
      await snapshotLocalChain();
    } catch (error) {
      console.error(
        "Final local chain checkpoint failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  for (const child of children) child.kill();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
console.log(
  "Sotto canvas: http://127.0.0.1:5173 · semantic backend: http://127.0.0.1:4318",
);
const firstExit = await Promise.race(
  children.map(async (child) => await child.exited),
);
await stop();
await Promise.all(children.map((child) => child.exited));
process.exitCode = firstExit;
