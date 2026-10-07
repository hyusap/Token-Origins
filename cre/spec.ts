import { z } from 'zod';
import { policyGraphSchema, validateGraph, policyHash, EXCHANGE_TRADE_URL, MAX_EXCHANGE_AGE_SECONDS } from './graph';

/**
 * The frozen execution request handed to every runner, including the CRE HTTP
 * trigger. Parsing it runs the full graph validation and checks the policy
 * hash, so a direct CRE caller cannot submit a cyclic, disconnected or
 * mislabelled graph.
 */
export const specificationSchema = z.object({
  version: z.literal(2),
  runId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  revision: z.number().int().min(1).max(1000000),
  graph: policyGraphSchema,
  policyHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  /** Exchange-trade freshness cap for this run. */
  maxAgeSeconds: z.number().int().min(1).max(MAX_EXCHANGE_AGE_SECONDS),
  /** false evaluates with live inputs and stops before any write. */
  broadcast: z.boolean().optional(),
}).strict().superRefine((spec, ctx) => {
  try {
    validateGraph(spec.graph);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['graph'], message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (policyHash(spec.graph) !== spec.policyHash)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['policyHash'], message: 'Policy hash does not match the graph' });
});
export type ExecutionSpecification = z.infer<typeof specificationSchema>;

export const PRICE_URL = EXCHANGE_TRADE_URL;
export type PriceObservation = { usd: number; observedAt: string; source: string; raw: string };
export function parsePrice(value: unknown): PriceObservation {
  const data = z.object({ price: z.string(), time: z.string().datetime({ offset: true }) }).parse(value);
  const usd = Number(data.price);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('Invalid price observation');
  return { usd, observedAt: data.time, source: PRICE_URL, raw: data.price };
}
