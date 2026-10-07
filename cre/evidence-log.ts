import { stringToHex, hexToString } from 'viem';

/**
 * CRE caps each workflow log line at 1 KB (LogLineLimit) and truncates longer
 * ones, so execution evidence leaves the workflow as numbered hex chunks that
 * the runner reassembles. Hex survives any decoration the CLI adds to a line.
 */
export const EVIDENCE_CHUNK_TAG = 'ORIGINS_EVIDENCE_CHUNK';
const CHUNK_HEX = 700;

export function evidenceChunks(json: string): string[] {
  const hex = stringToHex(json).slice(2);
  const total = Math.max(1, Math.ceil(hex.length / CHUNK_HEX));
  return Array.from({ length: total }, (_, i) => `${EVIDENCE_CHUNK_TAG} ${i + 1}/${total} ${hex.slice(i * CHUNK_HEX, (i + 1) * CHUNK_HEX)}`);
}

/** Rebuilds the evidence JSON from CLI output; throws if any chunk is missing or inconsistent. */
export function joinEvidenceChunks(output: string): string {
  const pattern = new RegExp(`${EVIDENCE_CHUNK_TAG} (\\d+)/(\\d+) ([0-9a-f]+)`, 'g');
  const parts = new Map<number, string>();
  let total = 0;
  for (const match of output.matchAll(pattern)) {
    const index = Number(match[1]), count = Number(match[2]);
    if (total && count !== total) throw new Error('Execution evidence chunks disagree on their count');
    total = count;
    parts.set(index, match[3]!);
  }
  if (!total) throw new Error('CRE returned no structured execution evidence');
  for (let i = 1; i <= total; i++) if (!parts.has(i)) throw new Error(`Execution evidence chunk ${i}/${total} is missing`);
  return hexToString(`0x${Array.from({ length: total }, (_, i) => parts.get(i + 1)).join('')}`);
}
