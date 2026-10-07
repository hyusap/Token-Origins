// Browser formatting shares the engine's own narration, so the canvas, the
// voice reply and the execution evidence describe a policy in one vocabulary.
// Validation, source resolution and policy hashing remain on the execution side.
import type { PolicyGraph, PolicyAction } from "../cre/graph";
import { phraseCondition, describeSource } from "../cre/graph";
export { sourceKey, describeSource, isLegacyShape, describeAction, describeGraph, phraseCondition, formatValue, nodeInputs } from "../cre/graph";
export const formatSol = (lamports: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 9 }).format(lamports / 1_000_000_000);
export const actionObjectId = (action: PolicyAction) => action.type === "solana-transfer" ? "action:solana-transfer" : "action:pause";

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
    if (node.kind === "price" || node.kind === "reading") result = describeSource(node.source);
    else if (node.kind === "math") result = `(${expression(node.left)} ${node.op === "-" ? "−" : node.op === "/" ? "÷" : "×"} ${expression(node.right)})`;
    else if (node.kind === "compare") result = nodes.get(node.input)?.kind === "price"
      ? `${expression(node.input)} ${node.op.replace("<=", "≤").replace(">=", "≥")} ${usd(node.value)}`
      // Readings and computed values carry their own units (%, ratio, token amount).
      : phraseCondition(graph as PolicyGraph, id).replace(" <= ", " ≤ ").replace(" >= ", " ≥ ");
    else if (node.kind === "time") result = phraseCondition(graph as PolicyGraph, id);
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
