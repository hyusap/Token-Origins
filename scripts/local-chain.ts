import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";

export type Rpc = (method: string, params?: unknown[]) => Promise<any>;
/** JSON-RPC helper for any localhost node. */
export const rpcAt = (url: string): Rpc => async (method, params = []) => {
  const reply = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await reply.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

/** Latest block time is within this many seconds of the wall clock. */
export const MAX_CLOCK_LAG_SECONDS = 5;

/**
 * A restored Anvil chain keeps its last block's timestamp until a new block is
 * mined, so a fresh report can look future-dated against it. Instead of
 * discarding the saved chain, mine one empty block at the current time and
 * check the clock caught up. Non-destructive: history, receipts and contracts
 * are untouched. Throws with a clear next step if the clock cannot be aligned.
 */
export async function alignLocalClock(rpc: Rpc, nowSeconds = () => Math.floor(Date.now() / 1000)) {
  const latest = async () => Number.parseInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp, 16);
  const before = await latest();
  const lagBefore = nowSeconds() - before;
  if (lagBefore > MAX_CLOCK_LAG_SECONDS) {
    // Change the ongoing node clock as well as the next block. Setting only
    // the next timestamp lets subsequent blocks drift back after a restore.
    await rpc("anvil_setTime", [nowSeconds()]);
    await rpc("evm_setNextBlockTimestamp", [Math.max(nowSeconds(), before + 1)]);
    await rpc("evm_mine", []);
  }
  const lagAfter = nowSeconds() - (await latest());
  if (Math.abs(lagAfter) > MAX_CLOCK_LAG_SECONDS)
    throw new Error(
      `Local chain clock is ${lagAfter}s off real time and could not be aligned. Saved receipts are intact. ` +
        "Check the host clock and restart Anvil with the saved snapshot. No chain state has been discarded.",
    );
  return { lagBefore, lagAfter, minedAlignmentBlock: lagBefore > MAX_CLOCK_LAG_SECONDS };
}

const vaultAbi = parseAbi(["function reportVersion() view returns (uint256)"]);
/** Report version a deployed vault accepts; null for a pre-v2 vault or no contract. */
export async function deployedReportVersion(rpc: Rpc, address: string): Promise<number | null> {
  try {
    const code = await rpc("eth_getCode", [address, "latest"]);
    if (!code || code === "0x") return null;
    const data = await rpc("eth_call", [{ to: address, data: encodeFunctionData({ abi: vaultAbi, functionName: "reportVersion" }) }, "latest"]);
    return Number(decodeFunctionResult({ abi: vaultAbi, functionName: "reportVersion", data }));
  } catch {
    return null;
  }
}
