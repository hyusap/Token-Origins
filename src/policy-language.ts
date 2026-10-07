import type { PolicyGraph, PolicyAction, PriceSource } from "../cre/graph";
// Browser-only formatting. Fixture tests pin these sentences to the engine;
// validation, source resolution and policy hashing remain on the execution side.
export const sourceKey = (source: PriceSource): string => source.type === "chainlink-feed"
  ? `chainlink-feed:${source.network || "ethereum-mainnet"}:${source.symbol}` : `exchange-trade:${source.pair}`;
export const describeSource = (source: PriceSource): string => source.type === "chainlink-feed"
  ? `Chainlink ${source.symbol}/USD (${!source.network || source.network === "ethereum-mainnet" ? "mainnet" : "Sepolia"})`
  : `Coinbase ${source.pair} trade`;
export function isLegacyShape(graph: PolicyGraph | undefined | null): boolean {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length !== 2 || graph.action?.type !== 'pause-vault') return false;
  const compare = graph.nodes.find((node) => node.kind === 'compare');
  const price = graph.nodes.find((node) => node.kind === 'price');
  return Boolean(
    compare && price && compare.kind === 'compare' && price.kind === 'price' &&
    compare.input === price.id && compare.op === '<' && graph.root === compare.id &&
    price.source.type === 'exchange-trade',
  );
}

export function describeAction(action: PolicyAction): string {
  return action.type === 'sell' ? `Simulated sell of ${action.amount} ${action.symbol}` : 'Pause grant vault spending';
}

export function describeGraph(graph: PolicyGraph): string {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const seen = new Set<string>();
  const phrase = (nodeId: string): string => {
    if (seen.has(nodeId)) return nodeId;
    seen.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) return nodeId;
    switch (node.kind) {
      case 'price':
        return describeSource(node.source);
      case 'compare':
        return `${phrase(node.input)} ${node.op} $${node.value.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
      case 'freshness':
        return `${phrase(node.input)} observed within ${node.maxAgeSeconds}s`;
      case 'vault-paused':
        return `vault is ${node.equals ? 'paused' : 'active'}`;
      case 'not':
        return `not (${phrase(node.input)})`;
      default:
        return `(${node.inputs.map(phrase).join(node.kind === 'and' ? ' and ' : ' or ')})`;
    }
  };
  const action =
    graph.action.type === 'sell'
      ? `Submit a simulated sell of ${graph.action.amount} ${graph.action.symbol}`
      : 'Pause spending';
  return `${action} when ${phrase(graph.root)}.`;
}
