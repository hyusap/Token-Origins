import { expect, test } from "bun:test";
import { creReadinessLabel, type CreReadiness } from "../src/cre-readiness";

const configured: CreReadiness = { executionAuthority: "chainlink-cre", mode: "cre-local-simulation", donDeployed: false, cliInstalled: true, authenticated: true, receiver: { address: "receiver", chainId: 11155111 }, signingKeyConfigured: true, readyForEvaluation: true, broadcastConfigured: true, fundingVerified: false, reason: "Configured; gas checked per run.", checkedAt: "2026-10-07T00:00:00Z" };
test("CRE availability distinguishes missing auth from local evaluation and never claims broadcast funding", () => {
  expect(creReadinessLabel(configured)).toBe("Local CRE evaluation available");
  expect(creReadinessLabel({ ...configured, authenticated: false })).toBe("CRE sign-in required");
  expect(creReadinessLabel({ ...configured, authenticated: null })).toBe("CRE authentication unverified");
  expect(creReadinessLabel({ ...configured, cliInstalled: false })).toBe("CRE CLI unavailable");
  expect(creReadinessLabel({ ...configured, receiver: null, readyForEvaluation: false })).toBe("CRE configuration required");
  expect(creReadinessLabel(configured)).not.toMatch(/funded|DON|ready to broadcast/i);
});
