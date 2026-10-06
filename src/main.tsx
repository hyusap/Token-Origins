/// <reference types="vite/client" />
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  Check,
  ArrowRight,
  LockKeyhole,
  Activity,
  Circle,
  ShieldCheck,
  X,
  CornerDownLeft,
} from "lucide-react";
import type { CanvasState, GraphObject, ExecutionRun } from "../shared/types";
import "./brand.css";
import "./style.css";
import "./app-layout.css";

const money = (n: number | undefined) =>
  typeof n === "number" && Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(n)
    : "—";
const short = (s?: string, size = 6) =>
  s ? `${s.slice(0, size + 2)}…${s.slice(-size)}` : "Awaiting deployment";
const clock = (s?: string) =>
  s ? new Date(s).toLocaleTimeString("en-GB", { hour12: false }) : "—";
const api = async (path: string, body?: unknown) => {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok)
    throw new Error(data.error || data.summary || "Connection unavailable");
  return data;
};

function settledExecutionReply(state: CanvasState, summary: string) {
  const run = state.runs[0];
  const prompt = state.conversation.filter((c) => c.role === "user").at(-1);
  if (
    !run ||
    !prompt ||
    Date.parse(run.startedAt) < Date.parse(prompt.at) ||
    !/queued|preparing|no result yet/i.test(summary)
  )
    return null;
  if (run.status === "confirmed")
    return `Execution v${run.revision.toString().padStart(2, "0")} confirmed at block ${run.evidence?.blockNumber}. The receiver event and fresh vault read verify spending is paused.`;
  if (run.status === "failed")
    return `Execution blocked: ${run.error || "The run could not be verified."}`;
  if (run.status === "no-op") {
    const failed = run.decisions.find((d) => !d.passed);
    return `No report sent. ${failed?.id === "vault-state" ? "The vault is already paused." : failed?.id === "freshness" ? "The source observation did not pass the freshness check." : failed?.id === "threshold" ? "The fetched price did not meet this version’s threshold." : "This run required no further action."}`;
  }
  return null;
}

function InlineSummary({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
    part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> :
    part.startsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part
  )}</>;
}

function useCanvas() {
  const [state, setState] = useState<CanvasState | null>(null);
  const [connected, setConnected] = useState(false);
  const acknowledged = useRef(new Set<string>());
  useEffect(() => {
    let active = true,
      ws: WebSocket,
      timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      api("/api/state")
        .then((s) => active && setState(s))
        .catch(() => {});
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          const next = msg.state || msg;
          if (next.sessionId) {
            setState(next);
            requestAnimationFrame(() => {
              const operationId = next.latency?.at(-1)?.operationId;
              if (!operationId || acknowledged.current.has(operationId)) return;
              acknowledged.current.add(operationId);
              fetch("/api/rendered", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  operationId,
                  renderedAt: new Date().toISOString(),
                }),
              }).catch(() => {});
            });
          }
        } catch {}
      };
      ws.onclose = () => {
        setConnected(false);
        if (active) timer = setTimeout(connect, 1800);
      };
    };
    connect();
    return () => {
      active = false;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);
  return { state, connected };
}

function BrandMark() {
  return (
    <svg
      width="28"
      height="32"
      viewBox="0 0 28 32"
      fill="none"
      aria-hidden="true"
    >
      <path d="M14 1 27 8.5v15L14 31 1 23.5v-15L14 1Z" stroke="currentColor" />
      <path d="M14 8v16M7 12l14 8M7 20l14-8" stroke="currentColor" />
      <circle
        cx="14"
        cy="16"
        r="3"
        fill="var(--bab-black)"
        stroke="currentColor"
      />
    </svg>
  );
}

type SignalMode = "ready" | "working" | "running" | "speaking" | "typing" | "offline" | "blocked";
function LiveSignal({ mode, sequence }: { mode: SignalMode; sequence: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const signal = useRef({ mode, sequence, changedAt: performance.now() });
  useEffect(() => {
    signal.current = { mode, sequence, changedAt: performance.now() };
  }, [mode, sequence]);
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let disposed = false;
    const draw = (now: number) => {
      if (disposed) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = el.clientWidth, height = el.clientHeight;
      if (el.width !== width * ratio || el.height !== height * ratio) {
        el.width = width * ratio; el.height = height * ratio;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const current = signal.current;
      const busy = ["working", "running", "speaking"].includes(current.mode);
      const offline = current.mode === "offline";
      const time = reduced.matches ? 0 : now / 1000;
      const pulse = reduced.matches ? 0 : Math.exp(-(now - current.changedAt) / 750);
      const amplitude = offline ? 0.03 : busy ? 0.78 : current.mode === "typing" ? 0.4 : 0.28;
      const bars = 65;
      const gap = width / (bars + 3);
      ctx.fillStyle = getComputedStyle(el).color;
      for (let i = 0; i < bars; i++) {
        const x = (i + 2) * gap;
        const envelope = Math.sin(Math.PI * (i + 1) / (bars + 1)) ** 1.6;
        const movement = 0.32 + Math.abs(Math.sin(i * .67 + time * (busy ? 4.8 : 1.1)) * Math.cos(i * .23 - time * 1.7)) * .68;
        const h = 2 + envelope * (amplitude * movement + pulse * .16) * (height - 8);
        ctx.globalAlpha = offline ? .25 : .35 + envelope * .65;
        ctx.fillRect(x, (height - h) / 2, 2, h);
      }
      ctx.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { disposed = true; cancelAnimationFrame(frame); };
  }, []);
  return <div className={`live-signal signal-${mode}`} role="status" aria-label={`Agent ${mode}`}>
    <canvas ref={canvas} aria-hidden="true" />
    <span className="signal-caption mono"><i />{mode === "working" ? "Working" : mode === "running" ? "Executing" : mode === "blocked" ? "Error" : mode.charAt(0).toUpperCase() + mode.slice(1)}</span>
  </div>;
}
function NodeHeader({
  index,
  type,
  extra,
}: {
  index: string;
  type: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="node-head">
      <span>
        {index} / {type}
      </span>
      {extra || <ArrowUpRight size={14} />}
    </div>
  );
}
function NodeFooter({ object }: { object: GraphObject }) {
  return (
    <div className="node-foot">
      <span>
        <i className="tiny-dot" />
        {object.provenance.kind === "chain"
          ? `Chain ${object.provenance.chainId} / block ${object.data.blockNumber}`
          : object.provenance.label}
      </span>
      <span>
        {clock(
          object.provenance.kind === "chain"
            ? object.provenance.fetchedAt
            : object.provenance.observedAt,
        )}
      </span>
    </div>
  );
}
function PriceChart({ object }: { object: GraphObject }) {
  const raw = object.data.history || object.data.samples || [];
  const points = raw
    .map((p: any) => Number(p.price ?? p.value ?? p))
    .filter(Number.isFinite);
  const price = Number(object.data.price ?? object.data.value);
  if (!points.length && price) points.push(price);
  const low = Math.min(...points) * 0.9995,
    high = Math.max(...points) * 1.0005;
  const path = points
    .map(
      (p: number, i: number) =>
        `${i ? "L" : "M"}${(i / Math.max(points.length - 1, 1)) * 290},${72 - ((p - low) / (high - low || 1)) * 54}`,
    )
    .join(" ");
  return (
    <div className="price-chart">
      <div className="chart-axis">
        <span>{money(high)}</span>
        <span>{money(low)}</span>
      </div>
      <svg
        viewBox="0 0 290 88"
        preserveAspectRatio="none"
        role="img"
        aria-label="ETH price observations"
      >
        <defs>
          <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="white" stopOpacity=".12" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M0 25H290 M0 57H290 M0 86H290"
          stroke="var(--bab-line-soft)"
          strokeDasharray="2 5"
        />
        {points.length > 1 && (
          <path d={`${path} L290 88 L0 88Z`} fill="url(#priceFill)" />
        )}
        <path
          d={path}
          fill="none"
          stroke="var(--bab-white)"
          strokeWidth="1.25"
        />
        {points.length === 1 && (
          <circle cx="145" cy="45" r="3" fill="var(--bab-white)" />
        )}
      </svg>
      <div className="chart-caption">
        <span>
          {points.length > 1
            ? `${points.length} actual observations`
            : "One source observation"}
        </span>
        <span>
          {raw[0]?.observedAt && raw.at(-1)?.observedAt
            ? `${clock(raw[0].observedAt)}—${clock(raw.at(-1).observedAt)}`
            : "ETH / USD"}
        </span>
      </div>
    </div>
  );
}
function PriceNode({
  object,
  focused,
}: {
  object: GraphObject;
  focused: boolean;
}) {
  return (
    <article
      className={`graph-node price-node ${focused ? "focused" : ""}`}
      data-object-id={object.id}
    >
      <NodeHeader
        index="01"
        type="Market observation"
        extra={<span className="live-label">Observed</span>}
      />
      <div className="node-body">
        <div className="asset-row">
          <svg
            className="eth-icon"
            width="26"
            height="38"
            viewBox="0 0 26 38"
            fill="none"
          >
            <path
              d="M13 0 25 20 13 27 1 20 13 0Z M1 23 13 30 25 23 13 38 1 23Z"
              stroke="currentColor"
            />
            <path
              d="M13 0v27M1 20l12-6 12 6"
              stroke="currentColor"
              opacity=".4"
            />
          </svg>
          <div>
            <h3>Ethereum</h3>
            <span className="mono sublabel">ETH / USD</span>
          </div>
        </div>
        <div className="price-value">
          {money(Number(object.data.price ?? object.data.value))}
        </div>
        <PriceChart object={object} />
      </div>
      <NodeFooter object={object} />
    </article>
  );
}
function VaultNode({
  object,
  focused,
}: {
  object: GraphObject;
  focused: boolean;
}) {
  const paused = !!object.data.paused;
  return (
    <article
      className={`graph-node vault-node ${focused ? "focused" : ""}`}
      data-object-id={object.id}
    >
      <NodeHeader
        index="02"
        type="Treasury instrument"
        extra={<LockKeyhole size={14} />}
      />
      <div className="node-body">
        <div className="vault-top">
          <div>
            <h3>Grant vault</h3>
            <span className="mono sublabel">
              {object.provenance.chainId === 31337
                ? "Local EVM / Anvil"
                : object.provenance.chainId === 11155111
                  ? "Ethereum / Sepolia"
                  : "Local rehearsal fixture"}
            </span>
          </div>
          <svg viewBox="0 0 80 80" className="vault-art" fill="none">
            <path
              d="M40 3 73 22v37L40 78 7 59V22L40 3Z M7 22l33 19 33-19 M40 41v37"
              stroke="currentColor"
            />
            <path
              d="m40 16 21 12v24L40 65 19 52V28l21-12Z"
              stroke="currentColor"
              opacity=".3"
            />
            <path
              d="M30 39v-7a10 10 0 0 1 20 0v7 M29 39h22v17H29V39Z"
              stroke="currentColor"
            />
          </svg>
        </div>
        <div className="vault-balance">
          {Number(object.data.balanceEth ?? object.data.balance ?? 0).toFixed(
            3,
          )}
          <span>ETH</span>
        </div>
        <div className="vault-state">
          <span className="mono">Spending</span>
          <span className={paused ? "signal" : ""}>
            {paused ? (
              <>
                <LockKeyhole size={12} /> Paused
              </>
            ) : (
              <>
                <Circle size={9} /> Active
              </>
            )}
          </span>
        </div>
        <div className="address mono">
          {short(object.provenance.address || object.data.address, 7)}
        </div>
      </div>
      <NodeFooter object={object} />
    </article>
  );
}
function Conditions({
  state,
  focused,
}: {
  state: CanvasState;
  focused: string | null;
}) {
  const w = state.workflow;
  const latest = state.runs[0];
  return (
    <article
      className={`graph-node condition-node ${focused?.startsWith("condition:") ? "focused" : ""}`}
    >
      <NodeHeader
        index="03"
        type="Policy conditions"
        extra={<span className="mono">AND</span>}
      />
      <div className="conditions">
        <div
          className={`condition-row ${focused === "condition:threshold" ? "condition-focus" : ""}`}
          data-object-id="condition:threshold"
        >
          <span className="condition-symbol">&lt;</span>
          <div>
            <span>Price below threshold</span>
            <strong>{money(w.threshold)}</strong>
          </div>
          <span className="condition-state">
            {latest?.revision === w.revision ? (
              latest.decisions.find(
                (d) => d.id.includes("threshold") || d.id.includes("price"),
              )?.passed ? (
                <Check size={14} />
              ) : (
                <span>—</span>
              )
            ) : (
              <span>01</span>
            )}
          </span>
        </div>
        {w.maxAgeSeconds !== null && (
          <div
            className={`condition-row ${focused === "condition:freshness" ? "condition-focus" : ""}`}
            data-object-id="condition:freshness"
          >
            <span className="condition-symbol">
              <Activity size={17} />
            </span>
            <div>
              <span>Fresh observation</span>
              <strong>Within {w.maxAgeSeconds} seconds</strong>
            </div>
            <span className="condition-state">02</span>
          </div>
        )}
        {w.skipPaused && (
          <div
            className={`condition-row ${focused === "condition:unpaused" ? "condition-focus" : ""}`}
            data-object-id="condition:unpaused"
          >
            <span className="condition-symbol">
              <ShieldCheck size={17} />
            </span>
            <div>
              <span>Vault is active</span>
              <strong>Skip if already paused</strong>
            </div>
            <span className="condition-state">03</span>
          </div>
        )}
      </div>
      <div className="condition-bottom mono">
        {1 + Number(w.maxAgeSeconds !== null) + Number(w.skipPaused)} predicates
        · all must pass
        {(w.maxAgeSeconds === null || !w.skipPaused) && (
          <span className="receiver-guards">
            Fresh data and active spending still gate execution.
          </span>
        )}
      </div>
    </article>
  );
}
function ActionNode({ focused }: { focused: boolean }) {
  return (
    <article
      className={`graph-node action-node ${focused ? "focused" : ""}`}
      data-object-id="action:pause"
    >
      <NodeHeader index="04" type="Report action" />
      <div className="node-body">
        <div className="action-icon">
          <LockKeyhole size={26} strokeWidth={1} />
        </div>
        <h3>Pause spending.</h3>
        <p>
          Send a verified report
          <br />
          to the grant vault.
        </p>
        <div className="action-call mono">
          onReport(bytes, bytes) <ArrowRight size={13} />
        </div>
      </div>
      <div className="node-foot">
        <span>Receiver-authorized</span>
        <ShieldCheck size={13} />
      </div>
    </article>
  );
}
function SourceNode({ object }: { object: GraphObject }) {
  return (
    <article className="graph-node source-node" data-object-id={object.id}>
      <NodeHeader index="00" type="External source" />
      <div className="node-body">
        <h3>{object.label}</h3>
        <p>
          Timestamped ETH/USD observations.
        </p>
        <span className="mono">{object.provenance.source}</span>
      </div>
    </article>
  );
}
function RunEvidence({
  run,
  previousPause,
}: {
  run: ExecutionRun;
  previousPause?: ExecutionRun;
}) {
  const done = ["confirmed", "no-op", "failed"].includes(run.status);
  return (
    <section
      className={`run-evidence ${done ? "settled" : ""}`}
      aria-label="Execution evidence"
      data-object-id={`run:${run.id}`}
    >
      <div className="evidence-title">
        <span className="mono">
          Pinned run / v{run.revision.toString().padStart(2, "0")}
        </span>
        <span className={`status-${run.status}`}>
          {run.status === "confirmed" ? (
            <>
              <Check size={13} /> Confirmed
            </>
          ) : run.status === "no-op" ? (
            "No action required"
          ) : run.status === "failed" ? (
            "Execution blocked"
          ) : (
            <>
              <span className="working-dot" />
              {run.status}
            </>
          )}
        </span>
      </div>
      <div className="frozen-rule">
        <span className="mono">Frozen threshold</span>
        <strong>{money(run.snapshot.threshold)}</strong>
      </div>
      {run.inputs && (
        <div className="execution-inputs">
          <span className="mono">Fetched ETH / USD</span>
          <strong>{money(Number(run.inputs.price.data.price))}</strong>
          <span className="mono">Source observation</span>
          <span className="mono">
            {clock(run.inputs.price.provenance.observedAt)}
          </span>
        </div>
      )}
      <div className="evidence-details">
        {run.decisions.map((d) => (
          <div className="decision" key={d.id}>
            <span className={d.passed ? "pass" : "fail"}>
              {d.passed ? <Check size={12} /> : <X size={12} />}
            </span>
            <span title={d.detail}>
              {d.label === "threshold"
                ? "Price below threshold"
                : d.label === "freshness"
                  ? "Fresh observation"
                  : d.label === "vault-state"
                    ? "Vault spending active"
                    : d.label}
            </span>
            <span className="mono">{d.passed ? "PASS" : "FALSE"}</span>
          </div>
        ))}
        {!run.decisions.length && <p>Fetching fresh execution inputs.</p>}
      </div>
      {run.evidence?.transactionHash && (
        <div className="receipt">
          <span className="mono">{short(run.evidence.transactionHash, 9)}</span>
          <span>
            {run.evidence.pausedAfter
              ? "Vault pause verified"
              : "Verifying receiver"}
          </span>
        </div>
      )}
      {!run.evidence?.transactionHash &&
        previousPause?.evidence?.transactionHash && (
          <div className="prior-receipt">
            <span className="mono">Earlier pause verified</span>
            <span className="mono">
              {short(previousPause.evidence.transactionHash, 7)}
            </span>
          </div>
        )}
      {run.error && <p className="execution-error">{run.error}</p>}
      <div className="evidence-footer mono">
        {run.executionMode}
        <span>{clock(run.startedAt)}</span>
      </div>
    </section>
  );
}

const POS = {
  price: { x: 72, y: 35, w: 340 },
  vault: { x: 745, y: 35, w: 320 },
  conditions: { x: 438, y: 135, w: 286 },
  action: { x: 775, y: 312, w: 290 },
  source: { x: 73, y: 310, w: 275 },
};
function Observatory({ state }: { state: CanvasState }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(620);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setScale(Math.min((r.width - 32) / 1140, (r.height - 44) / 620));
      setHeight(r.height);
    });
    observer.observe(wrap.current!);
    return () => observer.disconnect();
  }, []);
  const objects = state.objects.filter((o) => o.visible);
  const price = objects.find((o) => o.kind === "price");
  const vault = objects.find((o) => o.kind === "vault");
  const source = objects.find((o) => o.kind === "source");
  const focus = state.focus.objectId;
  const composed = state.workflow.created;
  const run =
    state.runs.find(
      (r) =>
        r.id ===
        (state as CanvasState & { inspectedRunId?: string }).inspectedRunId,
    ) || state.runs[0];
  const empty = !price && !vault;
  useEffect(() => {
    if (window.innerWidth <= 1000 && focus && wrap.current) {
      const el = wrap.current.querySelector<HTMLElement>(
        `[data-object-id="${focus}"]`,
      );
      if (el)
        wrap.current.scrollTo({
          top:
            wrap.current.scrollTop +
            el.getBoundingClientRect().top -
            wrap.current.getBoundingClientRect().top -
            (wrap.current.querySelector<HTMLElement>(".canvas-meta")
              ?.offsetHeight || 0) -
            16,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
        });
    }
  }, [focus]);
  return (
    <div
      className={`observatory ${empty ? "is-empty" : ""} mode-${state.mode}`}
      ref={wrap}
      aria-label="Voice controlled workflow canvas"
    >
      <div className="canvas-meta">
        <div className="canvas-coordinate top-left mono">
          {empty ? "New session" : "Treasury"}
        </div>
        <div className="canvas-coordinate top-right mono">
          {state.focus.label === "None" || !focus
            ? "No object in focus"
            : `Focused: ${state.focus.label}`}
        </div>
        {!empty && (
          <div className="mobile-continuation mono">
            Scroll for more ↓
          </div>
        )}
        {source?.pinned && (
          <div className="pinned-source">
            <span className="mono">Pinned source</span>
            <strong>{source.label}</strong>
            <span className="mono">ETH / USD feed</span>
          </div>
        )}
      </div>
      <div className="canvas-cross a">+</div>
      <div className="canvas-cross b">+</div>
      <div className="canvas-cross c">+</div>
      <div className="canvas-cross d">+</div>
      {empty ? (
        <div className="empty-scene">
          <div className="empty-caption">
            <p>Show me ETH’s price<br />and our grant vault.</p>
            <span className="mono">/ Type a prompt · Space Run the demo</span>
          </div>
        </div>
      ) : (
        <div
          className={`graph-stage ${focus && !focus.startsWith("workflow") && !focus.startsWith("run:") && focus !== "run" ? "has-focus" : ""}`}
          style={
            {
              width: 1140,
              height: 620,
              "--graph-inverse": Math.min(1.85, 1 / scale),
              transform: `translate(-50%, -50%) scale(${scale})`,
              top: height / 2,
            } as React.CSSProperties
          }
        >
          <svg
            className="graph-connections"
            viewBox="0 0 1140 620"
            aria-hidden="true"
          >
            <defs>
              <marker
                id="edgeArrow"
                markerWidth="6"
                markerHeight="6"
                refX="5"
                refY="3"
                orient="auto"
              >
                <path
                  d="M0 0 5 3 0 6"
                  fill="none"
                  stroke="var(--bab-line-lit)"
                />
              </marker>
            </defs>
            {composed ? (
              <>
                <path d="M412 148H424Q438 148 438 162" className="edge flow" />
                <path d="M745 148H734Q724 148 724 162" className="edge flow" />
                <path
                  d={`M581 ${278 + Number(state.workflow.maxAgeSeconds !== null) * 80 + Number(state.workflow.skipPaused) * 80}V454Q581 466 595 466H735Q750 466 750 452V390Q750 378 762 378H775`}
                  className="edge flow"
                  markerEnd="url(#edgeArrow)"
                />
                {state.workflow.maxAgeSeconds !== null && (
                  <path
                    d="M348 361H410Q425 361 425 346V246Q425 231 438 231"
                    className="edge"
                  />
                )}
                <text x="418" y="127" className="edge-label">
                  OBSERVE
                </text>
                <text x="686" y="127" className="edge-label">
                  READ
                </text>
                <text x="605" y="451" className="edge-label">
                  ALL TRUE → REPORT
                </text>
                <circle cx="581" cy="466" r="3" fill="var(--bab-white)" />
              </>
            ) : (
              <>
                <path d="M412 148H745" className="edge" strokeDasharray="3 5" />
                <text x="531" y="135" className="edge-label">
                  TREASURY CONTEXT
                </text>
                {source && <path d="M245 310V278" className="edge flow" />}
              </>
            )}
          </svg>
          {price && (
            <div
              className={`node-position price-position ${focus === price.id ? "in-focus" : ""}`}
              style={{
                left: POS.price.x,
                top: POS.price.y,
                width: POS.price.w,
              }}
            >
              <PriceNode object={price} focused={focus === price.id} />
            </div>
          )}
          {vault && (
            <div
              className={`node-position vault-position ${focus === vault.id ? "in-focus" : ""}`}
              style={{
                left: POS.vault.x,
                top: POS.vault.y,
                width: POS.vault.w,
              }}
            >
              <VaultNode object={vault} focused={focus === vault.id} />
            </div>
          )}
          {composed && (
            <>
              <div
                className={`node-position condition-position ${focus?.startsWith("condition:") ? "in-focus" : ""}`}
                style={{
                  left: POS.conditions.x,
                  top: POS.conditions.y,
                  width: POS.conditions.w,
                }}
              >
                <Conditions state={state} focused={focus} />
              </div>
              <div
                className={`node-position action-position ${focus === "action:pause" ? "in-focus" : ""}`}
                style={{
                  left: POS.action.x,
                  top: POS.action.y,
                  width: POS.action.w,
                }}
              >
                <ActionNode focused={focus === "action:pause"} />
              </div>
            </>
          )}
          {source && (
            <div
              className={`node-position source-position ${focus === source.id ? "in-focus" : ""}`}
              style={{
                left: POS.source.x,
                top: POS.source.y,
                width: POS.source.w,
              }}
            >
              <SourceNode object={source} />
            </div>
          )}
          {run && (
            <div className="run-position">
              <RunEvidence
                run={run}
                previousPause={state.runs.find(
                  (r) =>
                    r.status === "confirmed" && r.evidence?.transactionHash,
                )}
              />
            </div>
          )}
        </div>
      )}
      <div className="canvas-coordinate bottom-left mono">
        {objects.length.toString().padStart(2, "0")} objects <span>·</span>{" "}
        {state.edges.length.toString().padStart(2, "0")} connections
      </div>
      <div className="canvas-coordinate bottom-right mono">
        {composed
          ? `Draft v${state.workflow.revision.toString().padStart(2, "0")}`
          : "No rule yet"}{" "}
        <span className="coordinate-mark">⌜</span>
      </div>
      {state.clarification && (
        <div className="clarification">
          <span className="mono">One clarification</span>
          <h3>{state.clarification.question}</h3>
          <div>
            {state.clarification.candidates.map((c) => (
              <span key={c}>
                {state.objects.find((o) => o.id === c)?.label || c}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
function PolicyStrip({ state }: { state: CanvasState }) {
  const w = state.workflow;
  if (!w.created) return null;
  return <div className="policy-line">
    <span className="mono">Rule / v{w.revision.toString().padStart(2, "0")}</span>
    <p>If ETH falls below <strong>{money(w.threshold)}</strong>
      {w.maxAgeSeconds !== null ? <> with an observation under {w.maxAgeSeconds}s old</> : null}
      {w.skipPaused ? <> and the vault is active</> : null}, <em>pause grant spending.</em>
    </p>
  </div>;
}
function Inspector({
  state,
  agentStatus,
}: {
  state: CanvasState;
  agentStatus: any;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);
  const item = state.objects.find((o) => o.id === state.focus.objectId);
  const focusedRun = state.runs.find(
    (r) =>
      `run:${r.id}` === state.focus.objectId || r.id === state.inspectedRunId,
  );
  const pinnedSource = state.objects.find(
    (o) => o.kind === "source" && o.pinned,
  );
  const latest =
    [...state.latency].reverse().find((l) => l.renderMs !== undefined) ||
    state.latency.at(-1);
  return (
    <div
      className="inspector"
      ref={panel}
      tabIndex={0}
      role="complementary"
      aria-label="Provenance and execution proof"
    >
      <div className="inspector-head mono">
        Provenance & proof <ShieldCheck size={14} />
      </div>
      <dl>
        <dt>Focused object</dt>
        <dd>{state.focus.label || "None"}</dd>
        <dt>Source</dt>
        <dd>
          {item?.provenance.label ||
            focusedRun?.executionMode ||
            "Conversational context"}
        </dd>
        {item?.provenance.address && (
          <>
            <dt>Receiver</dt>
            <dd className="mono">{short(item.provenance.address, 8)}</dd>
          </>
        )}
        {item && (
          <>
            <dt>
              {item.provenance.kind === "chain" ? "Block time" : "Observation"}
            </dt>
            <dd className="mono">{clock(item.provenance.observedAt)}</dd>
            <dt>Fetched at</dt>
            <dd className="mono">{clock(item.provenance.fetchedAt)}</dd>
          </>
        )}
        {focusedRun && (
          <>
            <dt>Pinned execution</dt>
            <dd className="mono">
              v{focusedRun.revision.toString().padStart(2, "0")} /{" "}
              {short(focusedRun.id, 5)}
            </dd>
            <dt>Frozen threshold</dt>
            <dd>{money(focusedRun.snapshot.threshold)}</dd>
            {focusedRun.inputs && (
              <>
                <dt>Execution price</dt>
                <dd>{money(Number(focusedRun.inputs.price.data.price))}</dd>
                <dt>Input observation</dt>
                <dd className="mono">
                  {new Date(
                    focusedRun.inputs.price.provenance.observedAt,
                  ).toISOString()}
                </dd>
                <dt>Vault before execution</dt>
                <dd>
                  {focusedRun.inputs.vault.data.paused
                    ? "Already paused"
                    : "Spending active"}
                </dd>
              </>
            )}
            <dt>Receipt</dt>
            <dd>{focusedRun.evidence?.receiptStatus || focusedRun.status}</dd>
            {focusedRun.evidence?.blockNumber && (
              <>
                <dt>Block</dt>
                <dd className="mono">{focusedRun.evidence.blockNumber}</dd>
              </>
            )}
            {focusedRun.evidence?.verification && (
              <>
                <dt>Receiver verification</dt>
                <dd>{focusedRun.evidence.verification}</dd>
              </>
            )}
          </>
        )}
        {pinnedSource && (
          <>
            <dt>Pinned source</dt>
            <dd>{pinnedSource.label}</dd>
          </>
        )}
        <dt>State revision</dt>
        <dd className="mono">{state.seq}</dd>
        <dt>Latest commit</dt>
        <dd className="mono">
          {latest ? `${latest.commitMs.toFixed(1)} ms` : "—"}
        </dd>
        {latest?.renderMs !== undefined && (
          <>
            <dt>Commit to render</dt>
            <dd className="mono">{latest.renderMs.toFixed(1)} ms</dd>
          </>
        )}
      </dl>
      <div className="semantic-trace">
        <span className="mono muted">Semantic tool trace</span>
        {state.latency
          .filter((l) => !["set_activity", "submit_utterance"].includes(l.tool))
          .slice(-4)
          .map((l) => (
            <div key={l.operationId}>
              <span className="mono">{l.tool.replaceAll("_", " ")}</span>
              <span className="mono">{l.commitMs.toFixed(0)} ms</span>
            </div>
          ))}
        {agentStatus?.turns?.length > 0 && (
          <p>
            Last agent turn:{" "}
            {(agentStatus.turns.at(-1).durationMs / 1000).toFixed(1)}s<br />
            Microphone latency unmeasured.
          </p>
        )}
      </div>
    </div>
  );
}
function App() {
  const { state, connected } = useCanvas();
  const [text, setText] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [error, setError] = useState("");
  const [rehearsal, setRehearsal] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [speak, setSpeak] = useState(false);
  const [narrating, setNarrating] = useState(false);
  const narratedPrompt = useRef("");
  const narratedResponse = useRef("");
  const input = useRef<HTMLInputElement>(null);
  const submit = async (command: string) => {
    if (!command.trim()) return;
    setBusy(true);
    setError("");
    setConsoleOpen(false);
    try {
      const result = await api("/api/agent", { text: command });
      if (result.ok === false)
        throw new Error(result.error || result.summary || "Agent turn failed");
      setText("");
      setConsoleOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setError("");
    try {
      const result = await api("/api/rehearsal/start", {
        mode: "auto",
        reset: true,
      });
      if (result.ok === false)
        throw new Error(result.error || "Rehearsal could not start");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const stop = async () => {
    try {
      await api("/api/rehearsal/stop", {});
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const t = setInterval(
      () =>
        api("/api/rehearsal/status")
          .then(setRehearsal)
          .catch(() => {}),
      2000,
    );
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === "INPUT";
      if (e.key === "Escape") {
        setConsoleOpen(false);
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        stop();
      }
      if (typing) return;
      if (e.code === "Space") {
        e.preventDefault();
        rehearsal?.running ? stop() : start();
      }
      if (e.key === "/") {
        e.preventDefault();
        setConsoleOpen(true);
        setTimeout(() => input.current?.focus(), 0);
      }
      if (e.key.toLowerCase() === "i") setProofOpen((v) => !v);
      if (e.key.toLowerCase() === "v") setSpeak((v) => !v);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [rehearsal]);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    if (!speak) {
      window.speechSynthesis.cancel();
      setNarrating(false);
      return;
    }
    if (!state) return;
    const prompt = state.conversation.filter((c) => c.role === "user").at(-1);
    let narration = "";
    if (
      ["thinking", "executing"].includes(state.activity.status) &&
      prompt &&
      narratedPrompt.current !== prompt.id
    ) {
      narratedPrompt.current = prompt.id;
      narration = prompt.text;
    } else if (
      ["idle", "error"].includes(state.activity.status) &&
      state.activity.summary
    ) {
      const narrationSummary =
        settledExecutionReply(state, state.activity.summary) ||
        state.activity.summary;
      const responseKey = `${prompt?.id}:${narrationSummary}`;
      if (narratedResponse.current !== responseKey) {
        narratedResponse.current = responseKey;
        narration = narrationSummary;
      }
    }
    if (!narration) return;
    const utterance = new SpeechSynthesisUtterance(narration);
    utterance.lang = "en-US";
    utterance.rate = 0.98;
    window.speechSynthesis.cancel();
    utterance.onstart = () => setNarrating(true);
    utterance.onend = utterance.onerror = () => setNarrating(false);
    window.speechSynthesis.speak(utterance);
  }, [
    state?.conversation.length,
    state?.activity.status,
    state?.activity.summary,
    state?.runs[0]?.status,
    speak,
  ]);
  if (!state)
    return (
      <div className="connecting">
        <BrandMark />
        <h1>Sotto.</h1>
        <span className="mono">Connecting…</span>
        <p>
          Start the workspace with <code>bun run dev</code>.
        </p>
      </div>
    );
  const current = state.conversation.filter((c) => c.role === "user").at(-1);
  const response =
    state.activity.summary ||
    state.conversation.filter((c) => c.role === "assistant").at(-1)?.text;
  const settledReply = response ? settledExecutionReply(state, response) : null;
  const executingRun = state.runs.some(run => !["confirmed", "failed", "no-op"].includes(run.status));
  const signalMode: SignalMode = !connected ? "offline" : error || state.activity.status === "error" ? "blocked" : narrating ? "speaking" : executingRun ? "running" : busy || ["thinking", "executing"].includes(state.activity.status) ? "working" : consoleOpen ? "typing" : "ready";
  const running = rehearsal?.running || rehearsal?.status === "running";
  return (
    <div className="workbench-shell">
      <header className="appbar">
        <div className="app-brand"><BrandMark /><span>Sotto.</span></div>
        <div className="app-mode mono">{state.mode} <span>/</span> v{state.workflow.revision.toString().padStart(2, "0")}</div>
        <div className="appbar-actions">
          <span className="app-connection mono"><i className={connected ? "on" : ""} />{connected ? "Connected" : "Reconnecting"}</span>
          <button className="demo-control" onClick={running ? stop : start} disabled={!connected}>{running ? "Stop demo" : "Run demo"}<ArrowRight size={14} /></button>
        </div>
      </header>
      <main className={`workbench ${proofOpen ? "proof-open" : ""}`}>
        <Observatory state={state} />
        {proofOpen && <Inspector state={state} agentStatus={rehearsal} />}
        <section className="command-center" aria-label="Agent activity">
          <LiveSignal mode={signalMode} sequence={state.seq} />
          <div className="command-transcript" aria-live="polite">
            {current && <p key={current.id}>“{current.text}”</p>}
            <div className="command-response"><InlineSummary text={error || (["working", "running"].includes(signalMode) ? "" : settledReply || response || "")} /></div>
          </div>
          {running && <span className="cue-progress mono">Demo · prompt {rehearsal?.cueIndex ?? "—"}</span>}
        </section>
      </main>
      <PolicyStrip state={state} />
      <footer className="app-footer">
        <span className="mono">{state.capabilities.vault.toLowerCase().includes("anvil") ? "Local EVM / Anvil" : state.capabilities.vault}</span>
        <div className="app-shortcuts">
          <span><kbd>/</kbd> Prompt</span>
          <span><kbd>SPACE</kbd> Demo</span>
          <span><kbd>I</kbd> Proof</span>
          <span><kbd>V</kbd> {speak ? "Audio on" : "Audio"}</span>
          <span><kbd>ESC</kbd> Stop</span>
        </div>
        <span className="mono">{state.objects.filter(o => o.visible).length} objects / {state.runs.length} runs</span>
      </footer>
      {consoleOpen && (
        <div className="prompt-overlay">
          <form
            className="prompt-panel"
            onSubmit={(e) => {
              e.preventDefault();
              submit(text);
            }}
          >
            <div className="mono prompt-label">
              Prompt <span>ESC to close</span>
            </div>
            <input
              ref={input}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Focus on the vault…"
              aria-label="Prompt"
              disabled={busy}
            />
            <div className="prompt-instructions">
              <span>Codex / MCP</span>
              <button disabled={busy || !text.trim()} type="submit">
                {busy ? "Working…" : "Send"}
                <CornerDownLeft size={15} />
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
const container = document.getElementById("root")!;
const reactRoot = import.meta.hot
  ? (import.meta.hot.data.reactRoot ??= createRoot(container))
  : createRoot(container);
reactRoot.render(<App />);
