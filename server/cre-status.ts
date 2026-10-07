import { resolve } from "node:path";
import { creDeployment } from "../cre/deployment";

let cached: { expires: number; value: Awaited<ReturnType<typeof inspect>> } | undefined;
let pending: ReturnType<typeof inspect> | undefined;

/** Standard CLI authentication probe; account output and credentials never leave the process. */
async function inspect() {
  const bundled = resolve(import.meta.dir, "../cre/bin/cre");
  const binary = await Bun.file(bundled).exists() ? bundled : Bun.which("cre");
  let authenticated: boolean | null = null;
  if (binary) {
    const process = Bun.spawn([binary, "whoami", "--non-interactive"], {
      stdout: "ignore", stderr: "ignore",
    });
    const timeout = setTimeout(() => process.kill(), 10000);
    const exit = await process.exited;
    clearTimeout(timeout);
    authenticated = exit === 0 ? true : exit === 1 ? false : null;
  }
  let receiver: { address: string; chainId: number } | null = null;
  try {
    const deployment = await creDeployment();
    receiver = { address: deployment.address, chainId: deployment.chainId };
  } catch { /* Invalid configuration is represented explicitly below. */ }
  const signingKeyConfigured = Boolean(globalThis.process.env.CRE_ETH_PRIVATE_KEY);
  return {
    executionAuthority: "chainlink-cre" as const,
    mode: "cre-local-simulation" as const,
    donDeployed: false,
    cliInstalled: Boolean(binary), authenticated, receiver, signingKeyConfigured,
    readyForEvaluation: Boolean(binary && authenticated && receiver),
    broadcastConfigured: Boolean(binary && authenticated && receiver && signingKeyConfigured),
    fundingVerified: false,
    reason: !binary ? "Install the CRE CLI."
      : !authenticated ? "Sign in with cre/bin/cre login."
      : !receiver ? "Configure a report-v2 Sepolia receiver."
      : !signingKeyConfigured ? "Evaluation is available. A funded Sepolia test wallet is required for broadcast."
      : "CRE is configured. Gas and receiver readiness are checked for each run.",
    checkedAt: new Date().toISOString(),
  };
}

export async function creReadiness() {
  if (cached && cached.expires > Date.now()) return cached.value;
  pending ??= inspect();
  try {
    const value = await pending;
    cached = { value, expires: Date.now() + 15000 };
    return value;
  } finally { pending = undefined; }
}
