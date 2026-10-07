import { encodeFunctionData, decodeFunctionResult, decodeAbiParameters, parseAbi, parseAbiParameters, type Hex } from 'viem';
import { sourceIdentity, type ChainSource, type Network } from './graph';

/**
 * How every contract-backed source is read and decoded, shared by the CRE
 * workflow (synchronous capability calls) and the backend (async RPC). A read
 * is a generator that yields calls and receives their raw results, so both
 * drivers run exactly the same call plan and decoding.
 */
export interface ContractCall { network: Network; to: `0x${string}`; data: Hex }
export interface ContractReading {
  value: number;
  /** Raw integer the value was decoded from. */
  raw: string;
  /** Oracle write time for feeds; absent for state reads, which are observed when read. */
  updatedAt?: number;
  roundId?: string;
}

export const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
]);
export const erc20Abi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
export const aavePoolAbi = parseAbi(['function getReserveData(address asset) view returns (uint256)']);
export const cometAbi = parseAbi([
  'function getUtilization() view returns (uint64)',
  'function getSupplyRate(uint256 utilization) view returns (uint64)',
  'function baseToken() view returns (address)',
]);
const SECONDS_PER_YEAR = 31_536_000;

function decodeRound(data: Hex) {
  const [roundId, answer, , updatedAt] = decodeFunctionResult({ abi: aggregatorAbi, functionName: 'latestRoundData', data });
  return { roundId, answer, updatedAt };
}

/** The call plan for one contract-backed source. Yields calls; returns the decoded reading. */
export function* chainReading(source: ChainSource): Generator<ContractCall, ContractReading, Hex> {
  const identity = sourceIdentity(source);
  const network = identity.network!;
  const to = identity.address!;
  switch (source.type) {
    case 'chainlink-feed':
    case 'proof-of-reserve': {
      const { roundId, answer, updatedAt } = decodeRound(yield { network, to, data: encodeFunctionData({ abi: aggregatorAbi, functionName: 'latestRoundData' }) });
      // A price must be positive; a reserve may honestly be zero, which is the alarm it exists for.
      if (source.type === 'chainlink-feed' ? answer <= 0n : answer < 0n) throw new Error(`${identity.label} returned an invalid answer ${answer}`);
      if (updatedAt === 0n) throw new Error(`${identity.label} has no completed round`);
      return { value: Number(answer) / 10 ** identity.decimals!, raw: answer.toString(), updatedAt: Number(updatedAt), roundId: roundId.toString() };
    }
    case 'token-supply': {
      const supply = decodeFunctionResult({ abi: erc20Abi, functionName: 'totalSupply', data: yield { network, to, data: encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' }) } });
      return { value: Number(supply) / 10 ** identity.decimals!, raw: supply.toString() };
    }
    case 'lending-rate': {
      if (source.protocol === 'aave-v3') {
        // ReserveData starts (configuration, liquidityIndex, currentLiquidityRate, ...): the supply APR in ray (1e27).
        const data = yield { network, to, data: encodeFunctionData({ abi: aavePoolAbi, functionName: 'getReserveData', args: [identity.asset!] }) };
        if ((data.length - 2) / 2 < 96) throw new Error(`${identity.label}: getReserveData returned too little data`);
        const [, , rate] = decodeAbiParameters(parseAbiParameters('uint256,uint256,uint256'), `0x${data.slice(2, 2 + 192)}` as Hex);
        return { value: Number(rate) / 1e25, raw: rate.toString() };
      }
      // Compound v3: the supply rate is per second at the current utilisation, scaled by 1e18.
      const utilization = decodeFunctionResult({ abi: cometAbi, functionName: 'getUtilization', data: yield { network, to, data: encodeFunctionData({ abi: cometAbi, functionName: 'getUtilization' }) } });
      const rate = decodeFunctionResult({ abi: cometAbi, functionName: 'getSupplyRate', data: yield { network, to, data: encodeFunctionData({ abi: cometAbi, functionName: 'getSupplyRate', args: [utilization] }) } });
      return { value: Number(rate) * SECONDS_PER_YEAR / 1e16, raw: rate.toString() };
    }
  }
}
/** Contract calls a source costs against CRE's per-execution read quota. */
export const chainReadCost = (source: ChainSource): number => source.type === 'lending-rate' && source.protocol === 'compound-v3' ? 2 : 1;

/** Drives a read with synchronous calls (the CRE workflow). */
export function readChainSourceSync(source: ChainSource, call: (call: ContractCall) => Hex): ContractReading {
  const plan = chainReading(source);
  let step = plan.next();
  while (!step.done) step = plan.next(call(step.value));
  return step.value;
}
/** Drives a read with asynchronous calls (the backend's RPC client). */
export async function readChainSource(source: ChainSource, call: (call: ContractCall) => Promise<Hex>): Promise<ContractReading> {
  const plan = chainReading(source);
  let step = plan.next();
  while (!step.done) step = plan.next(await call(step.value));
  return step.value;
}
