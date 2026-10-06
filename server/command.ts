import { Engine } from "./engine";
// Bounded text fallback for keyboard rehearsal only. The Codex rehearsal path uses semantic MCP tools.
export async function command(
  engine: Engine,
  text: string,
  operationId = crypto.randomUUID(),
) {
  const caption = await engine.invoke("submit_utterance", {
    text,
    source: "Keyboard fallback · bounded parser",
    operationId: `${operationId}:caption`,
  });
  if (!caption.ok) return caption;
  const t = text.toLowerCase();
  const args = { operationId };
  const expectedRevision = engine.state.workflow.revision;
  if (/reset|start over|clear canvas/.test(t))
    return engine.invoke("reset_session", args);
  if (/show.*(eth|price).*(vault|treasury)|discover/.test(t))
    return engine.invoke("discover_objects", {
      objects: ["price", "vault"],
      ...args,
    });
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
        patch: { threshold },
        reason: text,
        ...args,
      });
  }
  if (/run|execute/.test(t))
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
  return engine.invoke("inspect_object", {
    reference: /vault/.test(t) ? "vault" : /price/.test(t) ? "price" : "this",
    ...args,
  });
}
