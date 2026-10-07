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
  return action.type === "pause-vault" ? "Pause grant vault spending" : `Transfer ${formatSol(action.amountLamports)} SOL to ${action.recipient} on ${action.network}`;
}
export const formatSol = (lamports: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 9 }).format(lamports / 1_000_000_000);
export const actionObjectId = (action: PolicyAction) => action.type === "pause-vault" ? "action:pause" : "action:solana-transfer";

export function describeGraph(graph: PolicyGraph): string {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const descriptions = new Map<string, string>();
  const visiting = new Set<string>();
  const phrase = (nodeId: string): string => {
    if (descriptions.has(nodeId)) return descriptions.get(nodeId)!;
    if (visiting.has(nodeId)) return nodeId;
    const node = byId.get(nodeId);
    if (!node) return nodeId;
    visiting.add(nodeId);
    let description: string;
    switch (node.kind) {
      case 'price': description = describeSource(node.source); break;
      case 'compare': description = `${phrase(node.input)} ${node.op} $${node.value.toLocaleString('en-US', { maximumFractionDigits: 8 })}`; break;
      case 'freshness': description = `${phrase(node.input)} observed within ${node.maxAgeSeconds}s`; break;
      case 'vault-paused': description = `vault is ${node.equals ? 'paused' : 'active'}`; break;
      case 'not': description = `not (${phrase(node.input)})`; break;
      default: description = `(${node.inputs.map(phrase).join(node.kind === 'and' ? ' and ' : ' or ')})`;
    }
    visiting.delete(nodeId);
    // Branch reuse can grow narration exponentially; execution still retains every node.
    const bounded = description.length > 4000 ? description.slice(0, 3999) + '…' : description;
    descriptions.set(nodeId, bounded);
    return bounded;
  };
  const action = graph.action.type === "pause-vault" ? "Pause spending" : describeAction(graph.action);
  return `${action} when ${phrase(graph.root)}.`;
}


const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < .01 ? 8 : 2 }).format(value);

/** A faithful presentation of the graph root, including nested boolean groups. */
export function policyExpression(graph: Pick<PolicyGraph, "nodes" | "root">): string {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const visiting = new Set<string>();
  const memo = new Map<string, string>();
  const expression = (id: string): string => {
    if (memo.has(id)) return memo.get(id)!;
    const node = nodes.get(id);
    if (!node || visiting.has(id)) return "Unavailable condition";
    visiting.add(id);
    let result: string;
    if (node.kind === "price") result = describeSource(node.source);
    else if (node.kind === "compare") result = `${expression(node.input)} ${node.op.replace("<=", "≤").replace(">=", "≥")} ${usd(node.value)}`;
    else if (node.kind === "freshness") result = `${expression(node.input)} age ≤ ${node.maxAgeSeconds}s`;
    else if (node.kind === "vault-paused") result = node.equals ? "vault is paused" : "vault is active";
    else if (node.kind === "not") result = `NOT (${expression(node.input)})`;
    else result = `(${node.inputs.map(expression).join(` ${node.kind.toUpperCase()} `)})`;
    visiting.delete(id);
    result = result.length > 4000 ? result.slice(0, 3999) + "…" : result;
    memo.set(id, result);
    return result;
  };
  return expression(graph.root);
}

export function policyConnective(graph: PolicyGraph): string {
  const root = graph.nodes.find(node => node.id === graph.root);
  return root?.kind === "and" || root?.kind === "or" || root?.kind === "not" ? root.kind.toUpperCase() : "IF";
}
