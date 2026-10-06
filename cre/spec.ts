import { z } from 'zod';
export const specificationSchema = z.object({
  runId:z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  revision:z.number().int().min(1).max(1000000),
  thresholdUsd:z.number().positive().max(10000000),
  maxAgeSeconds:z.number().int().min(1).max(120),
  requireFresh:z.boolean(), skipIfPaused:z.boolean(), broadcast:z.boolean().optional()
}).strict();
export type ExecutionSpecification=z.infer<typeof specificationSchema>;
export const PRICE_URL='https://api.exchange.coinbase.com/products/ETH-USD/ticker';
export type PriceObservation={usd:number;observedAt:string;source:string};
export type ConditionEvidence={kind:string;passed:boolean;detail:string};
export function parsePrice(value:unknown):PriceObservation {
  const data=z.object({price:z.string(),time:z.string().datetime({offset:true})}).parse(value);
  const usd=Number(data.price);
  if(!Number.isFinite(usd)||usd<=0) throw new Error('Invalid price observation');
  return {usd,observedAt:data.time,source:PRICE_URL};
}
export function evaluate(spec:ExecutionSpecification,price:PriceObservation,paused:boolean,nowMs:number):ConditionEvidence[] {
  const age=(nowMs-Date.parse(price.observedAt))/1000;
  return [
    {kind:'threshold',passed:Math.round(price.usd*100)<Math.round(spec.thresholdUsd*100),detail:`$${price.usd.toFixed(2)} < $${spec.thresholdUsd.toFixed(2)}`},
    // Even a draft without a freshness node retains the receiver's safety cap.
    {kind:'freshness',passed:Number.isFinite(age)&&age>=0&&age<=spec.maxAgeSeconds,detail:`Observation age ${age.toFixed(1)}s; maximum ${spec.maxAgeSeconds}s`},
    {kind:'vault-state',passed:!paused,detail:paused?'Vault already paused; no action needed':'Vault spending active'}
  ];
}
