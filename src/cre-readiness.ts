import { useEffect, useState } from "react";

export interface CreReadiness {
  executionAuthority: "chainlink-cre";
  mode: "cre-local-simulation";
  donDeployed: boolean;
  cliInstalled: boolean;
  authenticated: boolean | null;
  receiver: { address: string; chainId: number } | null;
  signingKeyConfigured: boolean;
  readyForEvaluation: boolean;
  broadcastConfigured: boolean;
  fundingVerified: boolean;
  reason: string;
  checkedAt: string;
}
export function creReadinessLabel(readiness: CreReadiness): string {
  if (!readiness.cliInstalled) return "CRE CLI unavailable";
  if (readiness.authenticated === false) return "CRE sign-in required";
  if (readiness.authenticated === null) return "CRE authentication unverified";
  return readiness.readyForEvaluation ? "Local CRE evaluation available" : "CRE configuration required";
}
export function useCreReadiness() {
  const [readiness, setReadiness] = useState<CreReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);
    let active = true;
    setLoading(true); setError("");
    fetch("/api/cre/capabilities", { signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok || result.ok === false || result.executionAuthority !== "chainlink-cre") throw new Error(result.error || "CRE readiness could not be checked.");
      if (active) setReadiness(result);
    }).catch(failure => {
      if (active) setError(failure.name === "AbortError" ? "CRE readiness check timed out." : failure.message);
    }).finally(() => { clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [revision]);
  return { readiness, loading, error, refresh: () => setRevision(value => value + 1) };
}
