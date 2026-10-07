import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localStatePath,
  validateLocalStateFile,
  snapshotLocalChain,
} from "./snapshot-local";
import { alignLocalClock, deployedReportVersion, rpcAt } from "./local-chain";
import { REPORT_VERSION } from "../cre/graph";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
      if (process.env.ORIGINS_RESET_LOCAL_CHAIN === "1") {
        // Explicit request only. The old chain is kept aside, never deleted.
        const aside = `${localStatePath}.aside-${Date.now()}`;
        await Bun.$`mv ${localStatePath} ${aside}`.quiet();
        await Bun.$`rm -f ${localStatePath}.metadata.json`.quiet();
        console.log(`ORIGINS_RESET_LOCAL_CHAIN=1: starting a clean chain; previous snapshot kept at ${aside}.`);
      } else await validateLocalStateFile();
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
  // A restored chain's clock lags until the next block; align it without
  // discarding any saved history.
  const clock = await alignLocalClock(rpcAt(rpc));
  if (clock.minedAlignmentBlock)
    console.log(`Local chain clock was ${clock.lagBefore}s behind; mined one alignment block. Saved history is intact.`);
  let deployed = false;
  try {
    const metadata = await Bun.file(
      resolve(root, "contracts/deployment.local.json"),
    ).json();
    const version = await deployedReportVersion(rpcAt(rpc), metadata.address);
    deployed =
      metadata.chainId === 31337 &&
      metadata.rpcUrl === rpc &&
      version === REPORT_VERSION;
    if (!deployed && metadata.address) {
      const code = await rpcCall("eth_getCode", [metadata.address, "latest"]);
      console.log(
        code.result && code.result !== "0x"
          ? `Vault ${metadata.address} predates report v${REPORT_VERSION}; deploying a new vault beside it (its history stays on chain).`
          : `No vault at ${metadata.address} on this chain; deploying one.`,
      );
    }
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
