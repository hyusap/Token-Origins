import { Engine } from "./engine";
// Bounded text fallback for keyboard rehearsal only. The Codex rehearsal path uses semantic MCP tools.
export async function command(
  engine: Engine,
  text: string,
  operationId: string = crypto.randomUUID(),
) {
  const caption = await engine.invoke("submit_utterance", {
    text,
    source: "Keyboard fallback · bounded parser",
    operationId: `${operationId}:caption`,
  });
  if (!caption.ok) return caption;
  const t = text.toLowerCase();
  const args = { operationId };
  const unsupported = (error: string) => ({
    ok: false,
    code: "UNSUPPORTED_COMMAND",
    summary: "No policy or execution changed.",
    error,
    state: engine.context(),
  });
  // The keyboard path is deliberately bounded. Never turn an unsupported
  // requested action into a successful inspection or a partial spending rule.
  if (/\b(copy[ -]?trad(?:e|ing)|swap|buy|sell|trade|transfer|liquidat(?:e|ion)|hedg(?:e|ing))\b/.test(t))
    return unsupported("Product actions require Chainlink CRE. Only CRE grant-vault pauses have an implemented receiver integration; direct transfers, swaps and copy-trading are unavailable. No substitute action was composed.");
  if (/\b(?:do not|don't|never)\s+(?:run|execute|reset|clear|pause)\b/.test(t))
    return unsupported("This instruction does not authorize an action. Use the Woga operator for conversational requests.");
  const expectedRevision = engine.state.workflow.revision;
  if (/^(?:please\s+)?(?:reset(?: the)?(?: canvas| session)?|start over|clear(?: the)? canvas)[.!]?\s*$/.test(t))
    return engine.invoke("reset_session", { ...args, expectedSessionId: engine.state.sessionId });
  if (/^(?:show|discover|fetch|get)\b/.test(t) && /price|discover/.test(t)) {
    const named = t.match(/price(?:s)?\s+(?:of|for)\s+(.+?)(?:\s+and\s+(?:our |the )?(?:grant )?(?:vault|treasury)|[?.!]|$)/)
      || t.match(/^(?:show|discover|fetch|get)\s+(?:me\s+)?(.+?)['’]?s?\s+price/);
    const tokens = named?.[1]?.replace(/['’]s$/, "").split(/\s+and\s+|,/).map(x => x.trim()).filter(Boolean);
    return engine.invoke("discover_objects", {
      objects: /vault|treasury/.test(t) || !tokens?.length ? ["price", "vault"] : ["price"],
      ...(tokens?.length ? { tokens } : {}),
      ...args,
    });
  }
  if (/focus|back to|keep.*visible|follow/.test(t)) {
    let reference = /source/.test(t)
      ? "source"
      : /vault|treasury/.test(t)
        ? "vault"
        : /price|eth/.test(t)
          ? "price"
          : /back/.test(t)
            ? "back"
            : "this";
    return engine.invoke("focus_object", {
      reference,
      pin: /keep|visible/.test(t),
      ...args,
    });
  }
  if (/undo/.test(t))
    return engine.invoke("undo_revision", { expectedRevision, ...args });
  if (/\b(?:if|when)\b/.test(t) && (/\b(?:and|or|not)\b/.test(t) || /%|\bpercent\b/.test(t)))
    return unsupported("The keyboard parser supports one absolute price threshold. Use the Woga operator and compose_graph for multiple conditions; specify how relative drops are measured.");
  const words = new Set(t.match(/[a-z0-9]+/g) || []);
  const selected = engine.state.objects.find(object => object.kind === "price" &&
    [object.data.symbol, object.data.name].some(name => typeof name === "string" && words.has(name.toLowerCase())));
  const focused = engine.state.objects.find(object => object.id === engine.state.focus.objectId);
  const conditionalAsset = (t.match(/\b(?:if|when)\s+([a-z0-9]+)\s+(?:is\s+)?(?:drops?|falls?|below|less than)/)
    || t.match(/^([a-z0-9]+)\s+(?:is\s+)?(?:drops?|falls?|below|less than)/))?.[1];
  if (conditionalAsset && !["it", "this", "that", "price", "the"].includes(conditionalAsset) && !selected)
    return unsupported(`Discover ${conditionalAsset.toUpperCase()}'s exact price source before composing its rule. No other asset was substituted.`);
  const priceReference = selected?.id || (/\b(it|this|that)\b/.test(t) && focused?.kind === "price" ? focused.id : undefined);
  const drop = t.match(/(?:drops?|falls?)\s+(?:more than\s+)?\$?([\d,.]+)/);
  if (drop && (selected || focused?.kind === "price")) {
    const observation = selected || focused!;
    return engine.invoke("patch_workflow", {expectedRevision, patch: {
      priceReference: observation.id, threshold: Math.round((observation.data.price - Number(drop[1]!.replaceAll(",", ""))) * 100) / 100
    }, reason: text, ...args});
  }
  if (/raise.*threshold|above.*current|test the pause/.test(t))
    return engine.invoke("patch_workflow", {
      expectedRevision,
      patch: { thresholdAboveCurrent: true },
      reason: text,
      ...args,
    });
  if (/fresh|already paused/.test(t))
    return engine.invoke("patch_workflow", {
      expectedRevision,
      patch: {
        ...(/fresh/.test(t) ? { maxAgeSeconds: 60 } : {}),
        ...(/already paused|skip/.test(t) ? { skipPaused: true } : {}),
      },
      reason: text,
      ...args,
    });
  if (/below|less than|threshold/.test(t)) {
    const number = t.match(/(?:below|than|threshold(?: to)?)\s*\$?([\d,.]+)/);
    const threshold = number
      ? Number(number[1]!.replaceAll(",", ""))
      : /three thousand/.test(t)
        ? 3000
        : null;
    if (threshold)
      return engine.invoke("patch_workflow", {
        expectedRevision,
        patch: { threshold, ...(priceReference ? { priceReference } : {}) },
        reason: text,
        ...args,
      });
  }
  if (/^(?:please\s+)?(?:run|execute)\b/.test(t))
    return engine.invoke("run_workflow", { expectedRevision, ...args });
  if (/explain.*happened|execution|result/.test(t))
    return engine.invoke("get_run", args);
  if (/whole rule|policy|summary/.test(t))
    return engine.invoke("focus_object", { reference: "workflow", ...args });
  if (/remove.*last condition/.test(t))
    return engine.invoke("patch_workflow", {
      expectedRevision,
      patch: engine.state.workflow.skipPaused
        ? { skipPaused: false }
        : { maxAgeSeconds: null },
      reason: text,
      ...args,
    });
  if (/^(?:show|inspect|explain|what|refresh|tell)\b/.test(t))
    return engine.invoke("inspect_object", {
      reference: /vault/.test(t) ? "vault" : /price/.test(t) ? "price" : "this",
      refresh: /\brefresh\b/.test(t),
      ...args,
    });
  return unsupported("The keyboard parser could not resolve that instruction. Use the Woga operator to discover sources, compose a policy, and run it.");
}
