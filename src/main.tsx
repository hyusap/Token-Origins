/// <reference types="vite/client" />
import React, { useEffect, useRef, useState, useMemo } from "react";
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
  Mic,
  MicOff,
  RotateCcw,
  Eraser,
  Plus,
  Minus,
  Maximize2,
} from "lucide-react";
import type {
  CanvasState,
  GraphObject,
  ExecutionRun,
  PolicyGraph,
} from "../shared/types";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, Handle, Position, useReactFlow, useNodesInitialized, useNodesState, type NodeProps, type Viewport } from "@xyflow/react";
import { canvasFlow, type InstrumentFlowNode } from "./flow-model";
import { isLegacyPolicy } from "./policy-shape";
import "@xyflow/react/dist/style.css";
import "./brand.css";
import "./style.css";
import "./app-layout.css";
import { microphoneLevels, type MicrophoneSnapshot } from "./microphone";
import { useMicrophone } from "./use-microphone";
import { displayReply } from "./display-reply";

const money = (n: number | undefined) =>
  typeof n === "number" && Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: n > 0 && n < 0.01 ? Math.min(20, Math.max(6, Math.ceil(-Math.log10(n)) + 2)) : 2,
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
function LiveSignal({ mode, microphone }: { mode: SignalMode; microphone: MicrophoneSnapshot }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef(microphone);
  useEffect(() => { input.current = microphone; }, [microphone]);
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    let frame = 0;
    let disposed = false;
    let samples = new Float32Array(2048);
    let measuredAt = 0;
    const draw = (now: number) => {
      if (disposed) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = el.clientWidth, height = el.clientHeight;
      if (!width || !height) { frame = requestAnimationFrame(draw); return; }
      if (el.width !== width * ratio || el.height !== height * ratio) {
        el.width = width * ratio; el.height = height * ratio;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const analyser = input.current.analyser;
      if (analyser) {
        if (samples.length !== analyser.fftSize) samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
      } else samples.fill(0);
      const { rms, levels } = microphoneLevels(samples, 21);
      const gap = width / (levels.length + 3);
      ctx.fillStyle = getComputedStyle(el).color;
      for (let i = 0; i < levels.length; i++) {
        const h = 2 + levels[i] * (height - 8);
        ctx.globalAlpha = .3 + levels[i] * .7;
        ctx.fillRect((i + 2) * gap, (height - h) / 2, 2, h);
      }
      ctx.globalAlpha = 1;
      if (now - measuredAt > 100) {
        el.dataset.audioSource = analyser ? "microphone" : "none";
        el.dataset.audioRms = rms.toFixed(5);
        el.dataset.audioSamples = String(analyser ? samples.length : 0);
        measuredAt = now;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { disposed = true; cancelAnimationFrame(frame); };
  }, []);
  const label = mode === "working" ? "Working" : mode === "running" ? "Executing" : mode === "blocked" ? "Error" : mode.charAt(0).toUpperCase() + mode.slice(1);
  return <div className={`live-signal signal-${mode} ${microphone.status === "live" ? "mic-live" : ""}`} role="status" aria-label={`${microphone.status === "live" ? "Microphone live" : "Microphone off"}; agent ${label.toLowerCase()}`}>
    <canvas ref={canvas} aria-hidden="true" />
    <span className="signal-caption mono" data-state={label}><i />{microphone.status === "live" ? "Mic live" : microphone.status === "requesting" ? "Mic permission…" : "Mic off"}<span className="signal-agent-state">{label}</span></span>
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
        {object.kind === "feed"
          ? `Chainlink aggregator / chain ${object.provenance.chainId}`
          : object.provenance.kind === "chain"
            ? `Chain ${object.provenance.chainId} / block ${object.data.blockNumber}`
            : object.provenance.label}
      </span>
      <span
        className={
          object.kind === "feed"
            ? Number(object.data.ageSeconds) > 3600
              ? "oracle-age is-stale"
              : "oracle-age"
            : undefined
        }
      >
        {object.kind === "feed"
          ? object.data.ageLabel
          : clock(
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
        aria-label={`${object.label} price observations`}
      >
        <defs>
          <linearGradient id={`priceFill-${object.id.replaceAll(":", "-")}`} x1="0" y1="0" x2="0" y2="1">
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
          <path d={`${path} L290 88 L0 88Z`} fill={`url(#priceFill-${object.id.replaceAll(":", "-")})`} />
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
            : object.label}
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
        type={object.kind === "feed" ? "Chainlink Data Feed" : "Market observation"}
        extra={
          object.kind === "feed" ? (
            <span className="oracle-badge">ON-CHAIN ORACLE</span>
          ) : (
            <span className="live-label">Observed</span>
          )
        }
      />
      <div className="node-body">
        <div className="asset-row">
          {object.data.symbol === "ETH" || object.id === "price:eth-usd" ? <svg
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
          </svg> : <span className="token-symbol mono">{object.data.symbol}</span>}
          <div>
            <h3>{object.data.name || (object.id === "price:eth-usd" ? "Ethereum" : object.data.symbol)}</h3>
            <span className="mono sublabel">{object.label}</span>
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
type GraphNodeLike = Record<string, any>;
/** Source naming duplicated from cre/graph.ts so the bundle stays zod-free. */
function sourceLabel(node: GraphNodeLike | undefined): string {
  const source = node?.source;
  if (!source) return "input";
  return source.type === "chainlink-feed"
    ? `Chainlink ${source.symbol}/USD`
    : `Coinbase ${source.pair}`;
}
function conditionRows(graph: PolicyGraph) {
  const byId = new Map<string, GraphNodeLike>(
    (graph.nodes as GraphNodeLike[]).map((n) => [n.id, n]),
  );
  const rows: { nodeId: string; symbol: string; label: string; value: string; oracle: boolean }[] = [];
  for (const node of graph.nodes as GraphNodeLike[]) {
    const input = byId.get(node.input);
    const oracle = input?.source?.type === "chainlink-feed";
    if (node.kind === "compare")
      rows.push({ nodeId: node.id, symbol: node.op, label: sourceLabel(input), value: money(Number(node.value)), oracle });
    else if (node.kind === "freshness")
      rows.push({ nodeId: node.id, symbol: "~", label: `${sourceLabel(input)} freshness`, value: `Within ${node.maxAgeSeconds}s`, oracle });
    else if (node.kind === "vault-paused")
      rows.push({ nodeId: node.id, symbol: "=", label: "Vault state", value: node.equals ? "Paused" : "Active", oracle: false });
  }
  const root = byId.get(graph.root);
  const connective = root?.kind === "or" ? "OR" : root?.kind === "not" ? "NOT" : "AND";
  return { rows, connective };
}
/** Renders a composed graph: real operators, real sources, real connective. */
function ComposedConditions({
  state,
  focused,
}: {
  state: CanvasState;
  focused: string | null;
}) {
  const w = state.workflow;
  const latest = state.runs[0];
  const { rows, connective } = conditionRows(w.graph);
  const current = latest?.revision === w.revision ? latest : undefined;
  return (
    <article
      className={`graph-node condition-node ${focused?.startsWith("condition:") ? "focused" : ""}`}
    >
      <NodeHeader index="03" type="Composed policy" extra={<span className="mono">{connective}</span>} />
      <div className="conditions">
        {rows.map((row, index) => {
          const result = current?.decisions.find((d) => d.nodeId === row.nodeId);
          return (
            <div
              key={row.nodeId}
              className={`condition-row ${focused === `condition:${row.nodeId}` ? "condition-focus" : ""}`}
              data-object-id={`condition:${row.nodeId}`}
            >
              <span className="condition-symbol">{row.symbol}</span>
              <div>
                <span>
                  {row.label}
                  {row.oracle && <span className="oracle-badge"> · ORACLE</span>}
                </span>
                <strong>{row.value}</strong>
              </div>
              <span className="condition-state">
                {result ? (result.passed ? <Check size={14} /> : <span>—</span>) : <span>{String(index + 1).padStart(2, "0")}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <div className="condition-bottom mono">
        {rows.length} predicate{rows.length === 1 ? "" : "s"} · combined with {connective}
        <span className="receiver-guards">
          Fresh data and active spending still gate execution.
        </span>
      </div>
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
          Timestamped {object.data.token || "ETH/USD"} observations.
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

function Instrument({ data }: NodeProps<InstrumentFlowNode>) {
  const { kind, state, focused, object, run } = data;
  return <div className={`flow-instrument ${focused ? "in-focus" : ""}`}>
    {kind === "price" && object && <PriceNode object={object} focused={focused} />}
    {kind === "vault" && object && <VaultNode object={object} focused={focused} />}
    {kind === "source" && object && <SourceNode object={object} />}
    {kind === "conditions" && (isLegacyPolicy(state.workflow.graph)
      ? <Conditions state={state} focused={state.focus.objectId} />
      : <ComposedConditions state={state} focused={state.focus.objectId} />)}
    {kind === "action" && <ActionNode focused={focused} />}
    {kind === "run" && run && <RunEvidence run={run} previousPause={state.runs.find(r => r.status === "confirmed" && r.evidence?.transactionHash)} />}
    {kind === "conditions" ? <>
      <Handle type="target" position={Position.Left} id="threshold" style={{ top: 80 }} isConnectable={false} />
      {state.workflow.maxAgeSeconds !== null && <Handle type="target" position={Position.Left} id="freshness" style={{ top: 150 }} isConnectable={false} />}
      {state.workflow.skipPaused && <Handle type="target" position={Position.Top} id="unpaused" isConnectable={false} />}
      <Handle type="source" position={Position.Left} id="out" style={{ top: "85%" }} isConnectable={false} />
    </> : kind === "action" ? <>
      <Handle type="target" position={Position.Right} id="in" isConnectable={false} />
      <Handle type="source" position={Position.Top} id="report" isConnectable={false} />
      <Handle type="source" position={Position.Left} id="evidence" isConnectable={false} />
    </> : kind === "vault" ? <>
      <Handle type="target" position={Position.Left} id="in" isConnectable={false} />
      <Handle type="target" position={Position.Bottom} id="report-in" style={{ left: "20%" }} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="out" style={{ left: "70%" }} isConnectable={false} />
    </> : <>
      <Handle type="target" position={kind === "run" ? Position.Right : Position.Left} id="in" isConnectable={false} />
      <Handle type="source" position={Position.Right} id="out" isConnectable={false} />
    </>}
  </div>;
}
const NODE_TYPES = { instrument: Instrument };
const FLOW_FIT = { padding: .1, maxZoom: 1, duration: 450 };
function FlowCanvas({ state, signalMode, microphone }: { state: CanvasState; signalMode: SignalMode; microphone: MicrophoneSnapshot }) {
  const graph = useMemo(() => canvasFlow(state), [state]);
  const [nodes, setNodes, onNodesChange] = useNodesState<InstrumentFlowNode>(graph.nodes);
  const flow = useReactFlow<InstrumentFlowNode>();
  const initialized = useNodesInitialized();
  const wrap = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const lastView = useRef("");
  const lastSession = useRef(state.sessionId);
  const currentState = useRef(state);
  currentState.current = state;
  useEffect(() => {
    if (lastSession.current !== state.sessionId) {
      lastSession.current = state.sessionId; lastView.current = "";
      flow.setViewport({ x: 0, y: 0, zoom: 1 });
    }
    setNodes(previous => graph.nodes.map(node => ({ ...node, position: previous.find(p => p.id === node.id)?.position || node.position })));
  }, [graph, setNodes, flow, state.sessionId]);
  const fit = () => flow.fitView(FLOW_FIT);
  const navigate = (action: string) => {
    if (action === "fit") { void fit(); return; }
    if (action === "zoom_in") { void flow.zoomIn({ duration: 250 }); return; }
    if (action === "zoom_out") { void flow.zoomOut({ duration: 250 }); return; }
    const viewport = flow.getViewport();
    const delta = 160;
    void flow.setViewport({ ...viewport, x: viewport.x + (action === "pan_left" ? delta : action === "pan_right" ? -delta : 0), y: viewport.y + (action === "pan_up" ? delta : action === "pan_down" ? -delta : 0) }, { duration: 250 });
  };
  useEffect(() => {
    if (!initialized || !nodes.length) return;
    const key = `${state.sessionId}:${state.canvasView?.sequence || 0}:${state.focus.objectId}:${nodes.map(node => node.id).join(",")}`;
    if (lastView.current === key) return;
    lastView.current = key;
    const action = state.canvasView?.action || "fit";
    if (action !== "focus") { navigate(action); return; }
    const id = state.focus.objectId?.startsWith("condition:") ? "conditions:and" : state.focus.objectId;
    const node = id ? flow.getNode(id) : null;
    if (!node || state.focus.objectId?.startsWith("workflow")) { void fit(); return; }
    const w = wrap.current?.clientWidth || 1000;
    const scale = Math.min(1.1, Math.max(.65, w / 1100));
    const width = node.measured?.width || Number(node.style?.width) || 330;
    const height = node.measured?.height || 240;
    void flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: scale, duration: 500 });
  }, [initialized, state.canvasView?.sequence, state.sessionId, state.focus.objectId, nodes.length]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest("input, textarea, .inspector") || event.metaKey || event.ctrlKey) return;
      const action: Record<string, string> = { "+": "zoom_in", "=": "zoom_in", "-": "zoom_out", "0": "fit", ArrowLeft: "pan_left", ArrowRight: "pan_right", ArrowUp: "pan_up", ArrowDown: "pan_down" };
      if (action[event.key]) { event.preventDefault(); navigate(action[event.key]); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [flow]);
  const empty = !graph.nodes.length;
  return <div className="observatory flow-canvas" ref={wrap} aria-label="Spatial workflow canvas" data-zoom={zoom.toFixed(3)}>
    <ReactFlow nodes={nodes} edges={graph.edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} fitView fitViewOptions={FLOW_FIT}
      minZoom={.2} maxZoom={2} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
      deleteKeyCode={null} panOnDrag panOnScroll zoomOnPinch zoomOnScroll={false} colorMode="dark" onMove={(_, viewport) => setZoom(viewport.zoom)}
      defaultEdgeOptions={{ type: "smoothstep" }}>
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="var(--bab-line)" />
      <Controls showInteractive={false} position="bottom-left" fitViewOptions={FLOW_FIT} />
    </ReactFlow>
    <div className="flow-metadata mono"><span>Treasury</span><span>{state.focus.objectId ? `Focused: ${state.focus.label}` : "No focus"}</span></div>
    <span className="flow-zoom mono">{Math.round(zoom * 100)}% · + − zoom · 0 fit</span>
    {empty && <div className="empty-caption"><p>Show me ETH’s price<br />and our grant vault.</p><span className="mono">/ Prompt · Space Demo</span></div>}
    {state.clarification && <div className="clarification"><span className="mono">Clarify</span><h3>{state.clarification.question}</h3><div>{state.clarification.candidates.map(id => <span key={id}>{state.objects.find(o => o.id === id)?.label || id}</span>)}</div></div>}
  </div>;
}
function Observatory(props: { state: CanvasState; signalMode: SignalMode; microphone: MicrophoneSnapshot }) {
  return <ReactFlowProvider><FlowCanvas {...props} /></ReactFlowProvider>;
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
  const [clearing, setClearing] = useState(false);
  const microphone = useMicrophone();
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
  const clearCanvas = async (restore = false) => {
    if (!state || clearing) return;
    setClearing(true); setError("");
    try {
      await api(restore ? "/api/canvas/restore" : "/api/canvas/clear", {
        operationId: crypto.randomUUID(), expectedSessionId: state.sessionId,
      });
      setText(""); setConsoleOpen(false); setProofOpen(false);
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    } catch (e) { setError((e as Error).message); }
    finally { setClearing(false); }
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
        microphone.stop();
      }
      if (typing) return;
      if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey) microphone.toggle();
      if (e.key === "Backspace" && e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); clearCanvas(); }
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
  }, [rehearsal, state?.sessionId, clearing, microphone.status]);
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
        displayReply(state.activity.summary);
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
          <div className="header-signal"><LiveSignal mode={signalMode} microphone={microphone} /></div>
          <button className={`mic-control ${microphone.status === "live" ? "on" : ""}`} onClick={microphone.toggle} aria-pressed={microphone.status === "live"} title="Microphone waveform · local audio only · M">
            {microphone.status === "live" ? <Mic size={15} /> : <MicOff size={15} />}
            <span>{microphone.status === "live" ? "Mic on" : microphone.status === "requesting" ? "Cancel mic" : "Mic"}</span>
          </button>
          {state.canUndoClear ? <button className="clear-control" onClick={() => clearCanvas(true)} disabled={clearing || busy || running} title="Restore the last cleared canvas"><RotateCcw size={14} /><span>Undo clear</span></button> : <button className="clear-control" onClick={() => clearCanvas()} disabled={clearing || busy || running || executingRun || !state.objects.length && !state.conversation.some(c => c.role === "user")} title="Clear canvas · contract state is unchanged"><Eraser size={14} /><span>Clear</span></button>}
          <span className="app-connection mono"><i className={connected ? "on" : ""} />{connected ? "Connected" : "Reconnecting"}</span>
          <button className="demo-control" onClick={running ? stop : start} disabled={!connected}>{running ? "Stop demo" : "Run demo"}<ArrowRight size={14} /></button>
        </div>
      </header>
      <main className={`workbench ${proofOpen ? "proof-open" : ""}`}>
        <Observatory state={state} signalMode={signalMode} microphone={microphone} />
        {proofOpen && <Inspector state={state} agentStatus={rehearsal} />}
        <section className="command-center" aria-label="Agent activity">
          <div className="command-transcript" aria-live="polite">
            {current && <p key={current.id}>{current.text}</p>}
            <div className="command-response"><InlineSummary text={displayReply(error || microphone.error || (["working", "running"].includes(signalMode) ? "" : settledReply || response || ""))} /></div>
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
          <span><kbd>M</kbd> Mic</span>
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
