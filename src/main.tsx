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
  Eraser,
  Plus,
  Minus,
  Maximize2,
  Command,
  ChevronRight,
  LoaderCircle,
} from "lucide-react";
import type {
  CanvasState,
  GraphObject,
  ExecutionRun,
  PolicyGraph,
} from "../shared/types";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, ControlButton, Handle, Position, useReactFlow, useNodesInitialized, useNodesState, type NodeProps, type Viewport } from "@xyflow/react";
import { canvasFlow, reconcileCanvasNodes, type InstrumentFlowNode } from "./flow-model";
import "@xyflow/react/dist/style.css";
import "./brand.css";
import "./style.css";
import "./app-layout.css";
import { microphoneLevels, type MicrophoneSnapshot } from "./microphone";
import { useMicrophone } from "./use-microphone";
import { useVoice, type VoiceStatus } from "./voice";
import { displayReply } from "./display-reply";
import { compactReply, replyBlocks } from "./reply-format";
import { observationOnlyForVault } from "../shared/policy-capabilities";
import { policyExpression, describeSource, actionObjectId, formatSol, describeAction } from "./policy-language";
import { policyView, frozenGraph, runOutcome, runProvenance, isEvaluationOnly, missingDecisionLabel, decisionRole, settledExecutionReply, vaultStateLabel } from "./policy-view";
import { useCreReadiness, creReadinessLabel } from "./cre-readiness";

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

function InlineSummary({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
    part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> :
    part.startsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part
  )}</>;
}
function ResponsePanel({ text, close }: { text: string; close: () => void }) {
  return <aside className="response-panel" aria-label="Full response">
    <div className="capability-head mono">Latest response<button onClick={close} aria-label="Close response"><X size={16} /></button></div>
    <div className="response-content">{replyBlocks(text).map((block, index) => block.kind === "table" ? <div className="response-table" key={index}><table><thead><tr>{block.headers.map((header, column) => <th key={column}><InlineSummary text={header} /></th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.headers.map((_, column) => <td key={column}><InlineSummary text={row[column] || ""} /></td>)}</tr>)}</tbody></table></div> : <p key={index}><InlineSummary text={block.text} /></p>)}</div>
  </aside>;
}

function useCanvas() {
  const [state, setState] = useState<CanvasState | null>(null);
  const [connected, setConnected] = useState(false);
  const applyState = (next: CanvasState) => setState(previous => !previous || next.seq >= previous.seq ? next : previous);
  const acknowledged = useRef(new Set<string>());
  useEffect(() => {
    let active = true,
      ws: WebSocket,
      timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          const next = msg.state || msg;
          if (next.sessionId) {
            if (!active) return;
            applyState(next);
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
  return { state, connected, applyState };
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
function LiveSignal({ mode, microphone, voiceStatus }: { mode: SignalMode; microphone: MicrophoneSnapshot; voiceStatus: VoiceStatus }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef(microphone);
  useEffect(() => { input.current = microphone; }, [microphone]);
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d");
    if (!ctx) return;
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
  const listening = voiceStatus === "listening";
  return <div className={`live-signal signal-${mode} ${microphone.status === "live" ? "mic-live" : ""}`} role="status" aria-label={listening ? "Voice dictation listening" : voiceStatus === "requesting" ? "Starting voice dictation" : "Voice dictation off"}>
    <canvas ref={canvas} aria-hidden="true" />
    <span className="signal-caption mono" data-state={listening ? "Listening" : voiceStatus === "requesting" ? "Starting voice" : mode === "running" ? "Executing" : mode === "working" ? "Composing" : ""}><i />{listening ? "Listening" : voiceStatus === "requesting" ? "Voice permission…" : "Mic off"}</span>
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
            ? Number(object.data.ageSeconds) > 26 * 3600
              ? "oracle-age is-stale"
              : "oracle-age"
            : undefined
        }
      >
        {object.kind === "feed"
          ? object.data.ageLabel || (object.provenance.observedAt ? clock(object.provenance.observedAt) : "Not fetched")
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
  if (!points.length && Number.isFinite(price) && price > 0) points.push(price);
  if (!points.length) return <div className="chart-empty mono">No price observations available</div>;
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
            <span className="oracle-badge">{object.provenance.observedAt ? "ON-CHAIN ORACLE" : "ORACLE INPUT"}</span>
          ) : (
            <span className="live-label">{object.provenance.observedAt ? "Observed" : "Not fetched"}</span>
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
        <p className="policy-restriction">
          {observationOnlyForVault(object)
            ? "Market observation only. Choose an exact USD source for an executable rule."
            : object.kind === "feed" ? "Timestamped USD readings published by Chainlink." : "Live USD trade observations from Coinbase."}
        </p>
      </div>
      <NodeFooter object={object} />
    </article>
  );
}
function VaultNode({
  object,
  focused,
  spendingLabel,
}: {
  object: GraphObject;
  focused: boolean;
  spendingLabel: string;
}) {
  const paused = !!object.data.paused;
  const balance = object.data.balanceEth ?? object.data.balance;
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
          {balance !== undefined && Number.isFinite(Number(balance)) ? Number(balance).toFixed(3) : "—"}
          <span>ETH</span>
        </div>
        <div className="vault-state">
          <span className="mono">{spendingLabel}</span>
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
function PolicyCondition({ state, node, focused }: {state:CanvasState; node:PolicyGraph["nodes"][number]; focused:boolean}) {
  const view = policyView(state);
  const input = "input" in node ? view.graph.nodes.find(n => n.id === node.input) : undefined;
  const result = view.run?.decisions.find(d => d.nodeId === node.id);
  const label = input?.kind === "price" ? describeSource(input.source) : "Condition";
  const title = node.kind === "compare" ? `${label} ${node.op} ${money(node.value)}` :
    node.kind === "freshness" ? `${label} within ${node.maxAgeSeconds}s` :
    node.kind === "vault-paused" ? `Vault is ${node.equals ? "paused" : "active"}` :
    node.kind.toUpperCase();
  const root = node.id === view.graph.root;
  return <article className={`graph-node condition-node ${focused ? "focused" : ""}`} data-object-id={`condition:${node.id}`}>
    <NodeHeader index="03" type={root ? "Policy root" : "Intermediate condition"} extra={<span className="mono">{node.kind.toUpperCase()}</span>} />
    <div className="node-body"><h3>{title}</h3>
      {(node.kind === "and" || node.kind === "or") && <p>{node.kind === "and" ? "Every input must be true." : "Any input can be true."}</p>}
      {node.kind === "not" && <p>Invert the connected condition.</p>}
      {result && <p className={root && !result.passed ? "execution-error" : "condition-value"}>
        {result.passed ? "TRUE" : "FALSE"} · {root ? "root expression" : "intermediate result"}
      </p>}
    </div>
    <div className="node-foot mono">{root ? "Freshness and action safeguards also apply" : "Evaluated from the connected inputs"}</div>
  </article>;
}
function ActionNode({ state, focused }: { state: CanvasState; focused: boolean }) {
  const view = policyView(state);
  const transfer = view.graph.action.type === "solana-transfer" ? view.graph.action : undefined;
  const sender = view.run?.target?.kind === "solana-wallet" ? view.run.target.sender : undefined;
  return (
    <article
      className={`graph-node action-node ${focused ? "focused" : ""}`}
      data-object-id={actionObjectId(view.graph.action)}
    >
      <NodeHeader index="04" type={transfer ? view.run ? "Archived action" : "Unavailable action" : "CRE action"} />
      <div className="node-body">
        <div className="action-icon">
          {transfer ? <ArrowUpRight size={26} strokeWidth={1} /> : <LockKeyhole size={26} strokeWidth={1} />}
        </div>
        <h3>{transfer ? `Transfer ${formatSol(transfer.amountLamports)} SOL.` : "Pause spending."}</h3>
        {transfer ? <><p>{view.run ? "Archived direct transfer. This path did not use CRE." : "Solana execution is unavailable in this workspace’s CRE workflow."}</p><dl className="action-addresses"><dt>Recipient</dt><dd className="mono" title={transfer.recipient}>{short(transfer.recipient, 7)}</dd>{sender && <><dt>Frozen sender</dt><dd className="mono" title={sender}>{short(sender, 7)}</dd></>}</dl></> : <p>Deliver a CRE report<br />to the grant vault.</p>}
        <div className="action-call mono">
          {transfer ? view.run ? "Historical evidence" : "CRE execution required" : "Report → verified receipt"} <ArrowRight size={13} />
        </div>
      </div>
      <div className="node-foot">
        <span>{transfer ? "Requires a supported CRE target" : "Vault permissions enforced"}</span>
        <ShieldCheck size={13} />
      </div>
    </article>
  );
}
function SolanaReceipt({ run }: { run: ExecutionRun }) {
  const receipt = run.evidence?.solanaTransfer;
  if (!receipt) return run.evidence?.submittedSignature ? <div className="receipt"><span className="mono" title={run.evidence.submittedSignature}>{short(run.evidence.submittedSignature, 8)}</span><span>Signature awaiting verification</span></div> : null;
  return <div className="solana-receipt">
    <a className="receipt-link mono" href={receipt.explorerUrl} target="_blank" rel="noopener noreferrer" title={receipt.signature}>{short(receipt.signature, 8)} <ArrowUpRight size={11} /></a>
    <dl><dt>Network</dt><dd>Solana {receipt.network}</dd><dt>Transfer</dt><dd>{formatSol(receipt.lamports)} SOL</dd><dt>Sender</dt><dd className="mono" title={receipt.sender}>{receipt.sender}</dd><dt>Recipient</dt><dd className="mono" title={receipt.recipient}>{receipt.recipient}</dd><dt>Confirmed slot</dt><dd className="mono">{receipt.slot}</dd><dt>Fee</dt><dd>{formatSol(receipt.feeLamports)} SOL</dd><dt>Recipient balance before</dt><dd>{formatSol(receipt.recipientBalanceBefore)} SOL</dd><dt>Recipient balance after</dt><dd>{formatSol(receipt.recipientBalanceAfter)} SOL</dd></dl>
    {receipt.replayed && <p>Existing confirmed receipt reused; no second transfer.</p>}
  </div>;
}
function SourceNode({ object }: { object: GraphObject }) {
  return (
    <article className="graph-node source-node" data-object-id={object.id}>
      <NodeHeader index="00" type="External source" />
      <div className="node-body">
        <h3>{object.label}</h3>
        <p>
          Timestamped {object.data.token || object.label} observations.
        </p>
        <span className="mono">{object.provenance.source}</span>
      </div>
    </article>
  );
}
function ObservationAge({ observedAt }: { observedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const age = (now - Date.parse(observedAt)) / 1000;
  return <span className="mono">{!Number.isFinite(age) ? "Age unavailable" : age < 0 ? `Observed ${Math.ceil(-age)}s ahead` : `Observed ${Math.floor(age)}s ago`}</span>;
}
function RunObservations({ run }: { run: ExecutionRun }) {
  if (!run.observations?.length) return null;
  return <div className="archived-observations">{run.observations.map(observation => <details className="archived-observation" key={observation.key} data-source-key={observation.key}>
    <summary><span>{observation.label}</span><strong>{money(observation.usd)}</strong><ChevronRight size={12} /></summary>
    <div><span>{observation.provider}{observation.network ? ` · ${observation.network}` : ""}{observation.chainId ? ` · chain ${observation.chainId}` : ""}</span>
      <span className="mono">{observation.observedAt}</span><ObservationAge observedAt={observation.observedAt} />
      <span className="mono">Fetched {observation.fetchedAt}</span>
      {observation.address && <span className="mono observation-address">{observation.address}</span>}
      <span className="mono">Raw {observation.raw}{observation.roundId ? ` · round ${observation.roundId}` : ""}</span>
    </div>
  </details>)}</div>;
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
      className={`run-evidence nowheel nopan ${done ? "settled" : ""}`}
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
            isEvaluationOnly(run) ? "Evaluated · no report" : "No action required"
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
        <span className="mono">Frozen policy</span>
        <span className="frozen-action">{describeAction(frozenGraph(run).action)}</span>
        <strong className="frozen-expression">{policyExpression(frozenGraph(run))}</strong>
      </div>
      <p className="run-outcome">{runOutcome(run)}</p>
      <div className="run-provenance"><span className="mono">Execution provenance</span><strong>{runProvenance(run).label}</strong><p>{runProvenance(run).detail}</p></div>
      <RunObservations run={run} />
      {!run.observations?.length && run.inputs?.price && (
        <div className="execution-inputs">
          <span className="mono">{run.inputs.price.label}</span>
          <strong>{money(Number(run.inputs.price.data.price ?? run.inputs.price.data.value))}</strong>
          <span className="mono">Source observation</span>
          <span className="mono">
            {clock(run.inputs.price.provenance.observedAt)}
          </span>
        </div>
      )}
      <div className="evidence-details">
        {run.decisions.map((d, index) => (
          <div className={`decision decision-${decisionRole(d)}`} data-result-role={decisionRole(d)} key={`${d.nodeId || d.id}:${index}`}>
            <span className={d.passed ? "pass" : decisionRole(d) === "node" ? "intermediate-false" : "fail"}>
              {d.passed ? <Check size={12} /> : decisionRole(d) === "node" ? <Circle size={12} /> : <X size={12} />}
            </span>
            <span title={d.detail}>
              <span className="result-role mono">{decisionRole(d) === "root" ? "Policy verdict" : decisionRole(d) === "guard" ? "Mandatory check" : "Intermediate"}</span>
              {d.detail || d.label}
            </span>
            <span className="mono">{d.passed ? "TRUE" : "FALSE"}</span>
          </div>
        ))}
        {!run.decisions.length && <p>{missingDecisionLabel(run)}</p>}
      </div>
      <SolanaReceipt run={run} />
      {!run.evidence?.simulatedOrder && run.evidence?.transactionHash && (
        <div className="receipt">
          {run.evidence.explorerUrl ? <a className="receipt-link mono" href={run.evidence.explorerUrl} target="_blank" rel="noopener noreferrer" title="View confirmed transaction">{short(run.evidence.transactionHash, 9)} <ArrowUpRight size={11} /></a> : <span className="mono" title={run.evidence.transactionHash}>{short(run.evidence.transactionHash, 9)}</span>}
          <span>
            {run.evidence.pausedAfter
              ? "Vault pause verified"
              : "Verifying receiver"}
          </span>
        </div>
      )}
      {frozenGraph(run).action.type === "pause-vault" && !run.evidence?.transactionHash &&
        previousPause?.evidence?.transactionHash && (
          <div className="prior-receipt">
            <span className="mono">Earlier pause verified</span>
            <span className="mono">
              {short(previousPause.evidence.transactionHash, 7)}
            </span>
          </div>
        )}
      {run.error && <p className="execution-error">{run.error}</p>}
      {run.policyHash && <div className="policy-hash mono" title={run.policyHash}>Policy {short(run.policyHash, 8)}</div>}
      <div className="evidence-footer mono">
        {run.executionMode}
        <span>{clock(run.startedAt)}</span>
      </div>
    </section>
  );
}

function Instrument({ data }: NodeProps<InstrumentFlowNode>) {
  const { kind, state, focused, object, run, graphNode } = data;
  if (kind === "section") return <div className="flow-section mono">{data.title}</div>;
  return <div className={`flow-instrument ${focused ? "in-focus" : ""} ${data.lane === "markets" && state.workflow.created ? "market-observation" : ""}`}>
    {kind === "price" && object && <PriceNode object={object} focused={focused} />}
    {kind === "vault" && object && <VaultNode object={object} focused={focused} spendingLabel={vaultStateLabel(state, object)} />}
    {kind === "source" && object && <SourceNode object={object} />}
    {kind === "conditions" && graphNode && <PolicyCondition state={state} node={graphNode} focused={focused} />}
    {kind === "action" && <ActionNode state={state} focused={focused} />}
    {kind === "run" && run && <RunEvidence run={run} previousPause={state.runs.find(r => r.status === "confirmed" && r.evidence?.transactionHash)} />}
    {kind === "conditions" ? <>
      <Handle type="target" position={Position.Left} id="in" style={{ top: 110 }} isConnectable={false} />
      <Handle type="source" position={Position.Right} id="out" style={{ top: 110 }} isConnectable={false} />
    </> : kind === "action" ? <>
      <Handle type="target" position={Position.Left} id="in" style={{ top: 110 }} isConnectable={false} />
      <Handle type="source" position={Position.Right} id="report" style={{ top: 110 }} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="evidence" isConnectable={false} />
    </> : kind === "vault" ? <>
      <Handle type="target" position={Position.Left} id="in" isConnectable={false} />
      <Handle type="target" position={Position.Left} id="report-in" style={{ top: 110 }} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="state" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="out" style={{ left: "70%" }} isConnectable={false} />
    </> : <>
      <Handle type="target" position={kind === "run" ? Position.Top : Position.Left} id="in" isConnectable={false} />
      <Handle type="source" position={Position.Right} id="out" style={{ top: 110 }} isConnectable={false} />
    </>}
  </div>;
}
const NODE_TYPES = { instrument: Instrument };
const FLOW_FIT = { padding: .08, minZoom: .2, maxZoom: 1, duration: 450 };
const motionDuration = (duration: number) => window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration;
function FlowCanvas({ state, signalMode, microphone }: { state: CanvasState; signalMode: SignalMode; microphone: MicrophoneSnapshot }) {
  const graph = useMemo(() => canvasFlow(state), [state]);
  const [nodes, setNodes, onNodesChange] = useNodesState<InstrumentFlowNode>(graph.nodes);
  const flow = useReactFlow<InstrumentFlowNode>();
  const initialized = useNodesInitialized();
  const wrap = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const [selectedObject, setSelectedObject] = useState("");
  const lastSize = useRef("");
  const lastFrozenRun = useRef<string | undefined>(undefined);
  const lastView = useRef("");
  const lastNodeIds = useRef<Set<string> | null>(null);
  const lastSession = useRef(state.sessionId);
  const currentState = useRef(state);
  currentState.current = state;
  useEffect(() => {
    if (!wrap.current) return;
    const observer = new ResizeObserver(entries => {
      const rectangle = entries[0]?.contentRect;
      if (!rectangle || !rectangle.width || !rectangle.height) return;
      setViewSize(previous => Math.abs(previous.width - rectangle.width) > 1 || Math.abs(previous.height - rectangle.height) > 1 ? { width: rectangle.width, height: rectangle.height } : previous);
    });
    observer.observe(wrap.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (lastSession.current !== state.sessionId) {
      lastSession.current = state.sessionId; lastView.current = "";
      lastNodeIds.current = null;
      flow.setViewport({ x: 0, y: 0, zoom: 1 });
    }
    setNodes(previous => reconcileCanvasNodes(previous, graph.nodes));
  }, [graph, setNodes, flow, state.sessionId]);
  const fit = (markets = false) => {
    setSelectedObject("");
    const lane = markets ? "markets" : state.workflow.created ? "policy" : null;
    return flow.fitView({ ...FLOW_FIT, duration: motionDuration(FLOW_FIT.duration), nodes: nodes.filter(node => !lane || node.data.lane === lane).map(node => ({ id: node.id })) });
  };
  const inspectObject = (id: string) => {
    if (!id) { void fit(); return; }
    setSelectedObject(id);
    void flow.fitView({ nodes: [{ id }], padding: .14, minZoom: .65, maxZoom: 1.1, duration: motionDuration(400) });
  };
  const objectLabel = (node: InstrumentFlowNode) => {
    if (node.data.object) return node.data.object.label;
    if (node.data.kind === "run") return `Execution evidence · v${node.data.run?.revision}`;
    if (node.data.kind === "action") { const action = policyView(state).graph.action; return action.type === "pause-vault" ? "Pause spending" : `Transfer ${formatSol(action.amountLamports)} SOL · devnet`; }
    const condition = node.data.graphNode;
    if (!condition) return node.id;
    if (condition.kind === "compare" || condition.kind === "freshness") {
      const source = policyView(state).graph.nodes.find(input => input.id === condition.input);
      const name = source?.kind === "price" ? source.source.type === "exchange-trade" ? source.source.pair : `Chainlink ${source.source.symbol}/USD` : "Input";
      return condition.kind === "compare" ? `${name} ${condition.op} ${money(condition.value)}` : `${name} freshness`;
    }
    if (condition.kind === "vault-paused") return condition.equals ? "Vault is paused" : "Vault is active";
    return `${condition.kind.toUpperCase()}${condition.id === policyView(state).graph.root ? " · policy root" : " · condition"}`;
  };
  const navigate = (action: string) => {
    if (action === "fit") { void fit(); return; }
    if (action === "zoom_in") { void flow.zoomIn({ duration: motionDuration(250) }); return; }
    if (action === "zoom_out") { void flow.zoomOut({ duration: motionDuration(250) }); return; }
    const viewport = flow.getViewport();
    const delta = 160;
    void flow.setViewport({ ...viewport, x: viewport.x + (action === "pan_left" ? delta : action === "pan_right" ? -delta : 0), y: viewport.y + (action === "pan_up" ? delta : action === "pan_down" ? -delta : 0) }, { duration: motionDuration(250) });
  };
  useEffect(() => {
    // State arrives before the controlled nodes are reconciled. Do not consume
    // navigation until React Flow has the current layout and measured cards.
    if (!initialized || !nodes.length || nodes.some(node => node.data.state !== state)) return;
    const cards = nodes.filter(node => node.data.kind !== "section");
    const added = lastNodeIds.current ? cards.filter(node => !lastNodeIds.current!.has(node.id)) : [];
    lastNodeIds.current = new Set(cards.map(node => node.id));
    const frozen = policyView(state).run?.id;
    const sizeKey = `${Math.round(viewSize.width)}:${Math.round(viewSize.height)}`;
    const resized = !!lastSize.current && lastSize.current !== sizeKey;
    const frozenChanged = lastFrozenRun.current !== frozen;
    lastSize.current = sizeKey; lastFrozenRun.current = frozen;
    const key = `${state.sessionId}:${state.canvasView?.sequence || 0}:${state.focus.objectId}:${state.workflow.created}:${frozen || "draft"}:${sizeKey}:${cards.map(node => node.id).join(",")}`;
    if (lastView.current === key) return;
    lastView.current = key;
    if (resized || frozenChanged) { void fit(); return; }
    // New content should be visible even when discovery leaves semantic focus
    // and the navigation sequence unchanged. Frame new cards after measurement.
    if (added.length) {
      if (added.some(node => node.data.kind === "conditions" || node.data.kind === "action")) void fit();
      else void flow.fitView({ ...FLOW_FIT, duration: motionDuration(FLOW_FIT.duration), nodes: added.map(node => ({ id: node.id })) });
      return;
    }
    const action = state.canvasView?.action || "fit";
    if (action !== "focus") { navigate(action); return; }
    const id = state.focus.objectId;
    const node = id ? flow.getNode(id) : null;
    if (!node || state.focus.objectId?.startsWith("workflow")) { void fit(); return; }
    const w = wrap.current?.clientWidth || 1000;
    const scale = Math.min(1.1, Math.max(.65, w / 1100));
    const width = node.measured?.width || Number(node.style?.width) || 330;
    const height = node.measured?.height || 240;
    void flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: scale, duration: motionDuration(500) });
  }, [initialized, state, nodes, viewSize]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest("input, textarea, button, a, summary, .inspector, .capability-panel") || event.metaKey || event.ctrlKey) return;
      const action: Record<string, string> = { "+": "zoom_in", "=": "zoom_in", "-": "zoom_out", "0": "fit", ArrowLeft: "pan_left", ArrowRight: "pan_right", ArrowUp: "pan_up", ArrowDown: "pan_down" };
      if (action[event.key]) { event.preventDefault(); navigate(action[event.key]); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [flow]);
  return <div className="observatory flow-canvas" ref={wrap} aria-label="Spatial workflow canvas" data-zoom={zoom.toFixed(3)}>
    <ReactFlow nodes={nodes} edges={graph.edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} fitView fitViewOptions={FLOW_FIT}
      minZoom={.2} maxZoom={2} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
      deleteKeyCode={null} panOnDrag panOnScroll zoomOnPinch zoomOnScroll={false} colorMode="dark" onMove={(_, viewport) => setZoom(viewport.zoom)}
      defaultEdgeOptions={{ type: "smoothstep" }}>
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="var(--bab-line)" />
      <Controls showInteractive={false} showFitView={false} position="bottom-left">
        <ControlButton onClick={() => void fit()} title={state.workflow.created ? "Fit active policy" : "Fit canvas"} aria-label={state.workflow.created ? "Fit active policy" : "Fit canvas"}><Maximize2 /></ControlButton>
      </Controls>
    </ReactFlow>
    {nodes.some(node => node.data.kind !== "section") && <div className="mobile-object-picker"><select aria-label="Inspect canvas object" value={nodes.some(node => node.id === selectedObject) ? selectedObject : ""} onChange={event => inspectObject(event.target.value)}><option value="">Policy overview</option>{nodes.filter(node => node.data.kind !== "section").map(node => <option key={node.id} value={node.id}>{objectLabel(node)}</option>)}</select><ChevronRight size={12} /></div>}
    <div className="flow-metadata mono"><span>Live canvas</span><div className="flow-view-actions">
      {state.workflow.created && <button onClick={() => void fit()}>Active policy</button>}
      {nodes.some(node => node.data.lane === "markets") && <button onClick={() => void fit(true)}>Market observations</button>}
      <span>{state.focus.objectId ? `Focused: ${state.focus.label}` : "No focus"}</span>
    </div></div>
    <span className="flow-zoom mono">{Math.round(zoom * 100)}% · <span className="desktop-zoom-hint">+ − zoom · 0 fit</span><span className="mobile-zoom-hint">pinch to zoom · drag to explore</span></span>
    {state.clarification && <div className="clarification"><span className="mono">Clarify</span><h3>{state.clarification.question}</h3><div>{state.clarification.candidates.map(id => <span key={id}>{state.objects.find(o => o.id === id)?.label || id}</span>)}</div></div>}
  </div>;
}
function Observatory(props: { state: CanvasState; signalMode: SignalMode; microphone: MicrophoneSnapshot }) {
  return <ReactFlowProvider><FlowCanvas {...props} /></ReactFlowProvider>;
}
function PolicyStrip({ state, watch, watching }: { state: CanvasState; watch: () => void; watching: boolean }) {
  const view = policyView(state);
  if (!state.workflow.created && !view.run) return null;
  return <div className="policy-line">
    <span className="mono">{view.run ? "Frozen run" : "Draft rule"} / v{view.revision.toString().padStart(2, "0")}</span>
    <p title={view.summary}>{view.summary}</p>
    {!view.run && view.graph.action.type === "pause-vault" && <button className="watch-rule" onClick={watch} disabled={watching || state.monitors?.some(monitor => ["active", "checking", "uncertain"].includes(monitor.status))} title="Freeze this revision and check every 30 seconds while the backend runs. Stop after one verified action."><Activity size={12} />{watching ? "Starting…" : "Watch rule"}</button>}
  </div>;
}
function CreReadinessDetails() {
  const { readiness, loading, error, refresh } = useCreReadiness();
  return <div className="cre-readiness" aria-live="polite">
    <strong>{loading ? "Checking CRE availability…" : error ? "CRE availability unverified" : readiness ? creReadinessLabel(readiness) : "CRE availability unverified"}</strong>
    {error ? <p>{error}</p> : readiness && <>
      <p>{readiness.reason}</p>
      <span>CRE local simulation{readiness.donDeployed ? "" : " · no deployed DON"}</span>
      <span>{readiness.broadcastConfigured ? "Broadcast configured" : "Broadcast not configured"}{readiness.fundingVerified ? " · funding verified" : " · funding unverified"}</span>
      {readiness.receiver && <span className="mono" title={readiness.receiver.address}>Receiver {short(readiness.receiver.address, 6)} · chain {readiness.receiver.chainId}</span>}
      <span className="mono">Checked {clock(readiness.checkedAt)}</span>
    </>}
    <button type="button" disabled={loading} onClick={refresh}>{loading ? "Checking…" : "Recheck CRE"}</button>
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
  const item = policyView(state).objects.find((o) => o.id === state.focus.objectId);
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
        <dt>Live CRE readiness</dt><dd><CreReadinessDetails /></dd>
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
            <dt>Frozen policy</dt>
            <dd>{describeAction(frozenGraph(focusedRun).action)}</dd>
            <dd>{policyExpression(frozenGraph(focusedRun))}</dd>
            <dt>Outcome</dt><dd>{runOutcome(focusedRun)}</dd>
            <dt>Execution provenance</dt><dd>{runProvenance(focusedRun).label}<p>{runProvenance(focusedRun).detail}</p></dd>
            <dt>Archived observations</dt><dd><RunObservations run={focusedRun} /></dd>
            {focusedRun.policyHash && <><dt>Policy hash</dt><dd className="mono" title={focusedRun.policyHash}>{short(focusedRun.policyHash, 8)}</dd></>}
            {focusedRun.inputs?.price && (
              <>
                <dt>Execution price</dt>
                <dd>{money(Number(focusedRun.inputs.price.data.price ?? focusedRun.inputs.price.data.value))}</dd>
                <dt>Input observation</dt>
                <dd className="mono">
                  {new Date(
                    focusedRun.inputs.price.provenance.observedAt,
                  ).toISOString()}
                </dd>
              </>
            )}
            {focusedRun.inputs?.vault && <><dt>Vault before execution</dt><dd>{focusedRun.inputs.vault.data.paused ? "Already paused" : "Spending active"}</dd></>}
            <dt>Receipt</dt>
            <dd>{focusedRun.evidence?.receiptStatus || focusedRun.status}</dd>
            {focusedRun.evidence?.solanaTransfer && <><dt>Verified Solana transfer</dt><dd><SolanaReceipt run={focusedRun} /></dd></>}
            {focusedRun.evidence?.blockNumber && (
              <>
                <dt>Block</dt>
                <dd className="mono">{focusedRun.evidence.blockNumber}</dd>
              </>
            )}
            {focusedRun.evidence?.verification && (
              <>
                <dt>Execution verification</dt>
                <dd>{focusedRun.evidence.verification}</dd>
              </>
            )}
            {focusedRun.evidence?.explorerUrl && <><dt>Transaction</dt><dd><a className="receipt-link" href={focusedRun.evidence.explorerUrl} target="_blank" rel="noopener noreferrer">View on explorer <ArrowUpRight size={12} /></a></dd></>}
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
function Capabilities({ state, close, stopMonitor, stopping, voiceProvider }: { state: CanvasState; close: () => void; stopMonitor: (id: string) => void; stopping: string | null; voiceProvider?: string }) {
  const supported = state.capabilities.supported;
  const [proof, setProof] = useState<{ kind: string; executionMode?: string; provenance?: string; evidence: { verifiedAt: string; transactionHash: string; blockNumber: string; status: string }; explorerUrl: string } | null>(null);
  useEffect(() => { let active = true; api("/api/proof").then(result => { if (active && result.kind === "saved-public-proof" && result.evidence?.status === "success") setProof(result); }).catch(() => {}); return () => { active = false; }; }, []);
  return <aside className="capability-panel" aria-label="Available capabilities">
    <div className="capability-head mono">Connected capabilities<button onClick={close} aria-label="Close capabilities"><X size={16} /></button></div>
    <h2>Real inputs.<br />Verifiable outcomes.</h2>
    <dl>
      <dt>Market observations</dt><dd>{state.capabilities.price}</dd>
      <dt>Vault</dt><dd>{state.capabilities.vault}</dd>
      <dt>CRE execution</dt><dd>{state.capabilities.execution}</dd>
      <dt>Live CRE readiness</dt><dd><CreReadinessDetails /></dd>
      <dt>Composition</dt><dd>Combine price comparisons, freshness and vault state with AND, OR and NOT. Execution checks source validity and the selected action’s safeguards.</dd>
      <dt>Execution trigger</dt><dd>{state.monitors || supported?.monitoring ? "Run a frozen policy once, or explicitly watch it while the backend runs. Watching stops after one verified action. Backend restarts pause monitoring." : supported?.triggers || "Run a frozen policy once."}</dd>
      {state.monitors?.length ? <><dt>Policy monitors</dt><dd className="monitor-list">{state.monitors.map(monitor => <section className="monitor-card" key={monitor.id}>
        <div className="monitor-title"><strong>Frozen v{monitor.spec.revision}</strong><span className={`monitor-status monitor-${monitor.status}`}>{monitor.status}</span></div>
        <p>{policyExpression(monitor.spec.graph)}</p>
        <p className="monitor-action">{describeAction(monitor.spec.graph.action)}</p>
        <span className="mono">{monitor.target.kind === "solana-wallet" ? "Solana devnet" : monitor.target.chainId === 11155111 ? "Sepolia" : "Local Anvil"} · {short(monitor.target.kind === "solana-wallet" ? monitor.target.sender : monitor.target.address, 5)}</span>
        <span className="mono">{monitor.checks} checks · every {monitor.intervalSeconds}s</span>
        {monitor.nextCheckAt && <span className="mono">Next check {clock(monitor.nextCheckAt)}</span>}
        <span className="mono">Updated {clock(monitor.updatedAt)}</span>
        {(monitor.lastError || monitor.stopReason) && <p className="monitor-note">{monitor.lastError || monitor.stopReason}</p>}
        {["active", "checking"].includes(monitor.status) && <button onClick={() => stopMonitor(monitor.id)} disabled={!!stopping}>{stopping === monitor.id ? "Stopping…" : "Stop watching"}<X size={11} /></button>}
      </section>)}</dd></> : null}
      <dt>Voice</dt><dd>{voiceProvider === "local" ? "Mic records one command and sends it to this workspace’s local Whisper speech engine." : voiceProvider === "checking" ? "Checking availability of the workspace’s local speech engine." : "Mic dictates one command through your browser’s speech recognition service, which may process audio remotely."} Recognized final speech uses the same agent bridge as typed commands. Microphone permission is required; typing remains available.</dd>
      {proof && <><dt>Saved Sepolia proof</dt><dd>{proof.executionMode === "cre-local-simulation" && proof.provenance && <p>{proof.provenance}</p>}<p>A treasury pause was independently verified at block {proof.evidence.blockNumber}. This is a historical public-chain receipt.</p><a className="receipt-link" href={proof.explorerUrl} target="_blank" rel="noopener noreferrer">View verified transaction <ArrowUpRight size={12} /></a><p className="mono proof-verified-at">Verified {new Date(proof.evidence.verifiedAt).toLocaleString()}</p></dd></>}
    </dl>
    <p className="capability-note">Actions require the supported CRE workflow. A local CRE simulation and a public transaction receipt are distinct evidence; each run identifies its execution path.</p>
  </aside>;
}
function App() {
  const { state, connected, applyState } = useCanvas();
  const [text, setText] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [responseOpen, setResponseOpen] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  const [watching, setWatching] = useState(false);
  const [stoppingMonitor, setStoppingMonitor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [rehearsal, setRehearsal] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const submitLocked = useRef(false);
  const microphone = useMicrophone();
  const input = useRef<HTMLInputElement>(null);
  const dockInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setShowDraft(false); }, [state?.sessionId, state?.inspectedRunId]);
  const watchPolicy = async () => {
    if (!state || watching) return;
    setWatching(true); setError("");
    try {
      const result = await api("/api/tools/activate_policy", { expectedRevision: state.workflow.revision, intervalSeconds: 30, operationId: crypto.randomUUID() });
      if (!result.ok) throw new Error(result.error || result.summary || "Monitoring could not start");
      applyState(result.state); setCapabilitiesOpen(true); setProofOpen(false);
    } catch (failure) { setError((failure as Error).message); }
    finally { setWatching(false); }
  };
  const stopMonitor = async (monitorId: string) => {
    if (stoppingMonitor) return;
    setStoppingMonitor(monitorId); setError("");
    try {
      const result = await api("/api/tools/deactivate_policy", { monitorId, operationId: crypto.randomUUID() });
      if (!result.ok) throw new Error(result.error || result.summary || "Monitor could not stop");
      applyState(result.state);
    } catch (failure) { setError((failure as Error).message); }
    finally { setStoppingMonitor(null); }
  };
  const submit = async (command: string) => {
    if (!command.trim() || submitLocked.current || clearing || !connected) return false;
    submitLocked.current = true;
    setBusy(true);
    setError("");
    setConsoleOpen(false);
    try {
      const result = await api("/api/agent", { text: command });
      if (result.ok === false)
        throw new Error(result.error || result.summary || "Agent turn failed");
      setText("");
      setConsoleOpen(false);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      submitLocked.current = false;
      setBusy(false);
    }
  };
  const voice = useVoice({
    canStart: () => connected && !submitLocked.current && !clearing,
    onCommand: async command => {
      const accepted = await submit(command);
      if (!accepted) setText(command);
      return accepted;
    },
  });
  const dictating = ["requesting", "listening"].includes(voice.status);
  const transcribing = voice.status === "transcribing";
  const captureSnapshot: MicrophoneSnapshot = voice.provider === "local" ? { status: voice.status === "listening" ? "live" : voice.status === "requesting" ? "requesting" : "off", analyser: voice.analyser || null, error: "" } : microphone;
  const voiceError = voice.status === "error" ? voice.error : "";
  const toggleVoice = () => {
    if (dictating || transcribing) { voice.stop(); microphone.stop(); return; }
    if (voice.status === "checking") return;
    if (!voice.supported || !connected || submitLocked.current || clearing || voice.status === "submitting") { voice.start(); return; }
    voice.start();
    // The waveform is real local capture, started by the same explicit gesture.
    if (voice.provider !== "local") microphone.toggle();
  };
  useEffect(() => {
    if (voice.provider === "local" || !["requesting", "listening"].includes(voice.status)) microphone.stop();
    if (voice.status === "error" && voice.finalTranscript) setText(previous => previous || voice.finalTranscript);
  }, [voice.status, voice.provider]);
  const clearCanvas = async () => {
    if (!state || clearing) return;
    setClearing(true); setError("");
    voice.stop(); microphone.stop();
    try {
      const result = await api("/api/canvas/clear", {
        operationId: crypto.randomUUID(), expectedSessionId: state.sessionId,
      });
      applyState(result.state);
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
      const typing = !!(e.target as HTMLElement)?.closest("input, textarea, select, button, a, summary, [contenteditable=true]");
      if (e.key === "Escape") {
        setConsoleOpen(false);
        setProofOpen(false);
        setCapabilitiesOpen(false);
        setResponseOpen(false);
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        stop();
        microphone.stop();
        voice.stop();
      }
      if (typing) return;
      if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey) toggleVoice();
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
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [rehearsal, state?.sessionId, clearing, voice.status, connected]);
  if (!state)
    return (
      <div className="connecting">
        <BrandMark />
        <h1>Woga.</h1>
        <span className="mono">Connecting…</span>
        <p>
          Start the workspace with <code>bun run dev</code>.
        </p>
      </div>
    );
  const executingRun = state.runs.some(run => !["confirmed", "failed", "no-op"].includes(run.status));
  const signalMode: SignalMode = !connected ? "offline" : error || voiceError || microphone.error ? "blocked" : executingRun ? "running" : busy || transcribing ? "working" : dictating ? "speaking" : consoleOpen ? "typing" : "ready";
  const running = rehearsal?.running || rehearsal?.status === "running";
  const activeMonitors = state.monitors?.filter(monitor => ["active", "checking"].includes(monitor.status)) || [];
  const activeWatchCount = activeMonitors.length;
  const frozenRun = policyView(state).run;
  const presentedState = showDraft && frozenRun ? { ...state, inspectedRunId: undefined, focus: { objectId: null, label: "Draft policy" } } : state;
  const prompt = state.conversation.filter(entry => entry.role === "user").at(-1)?.text;
  const reply = settledExecutionReply(state, state.activity.summary) || displayReply(state.activity.summary || state.conversation.filter(entry => entry.role === "assistant").at(-1)?.text || "");
  const caption = compactReply(reply);
  const empty = !state.objects.some(object => object.visible) && !state.workflow.created;
  const composeExample = (value: string) => { setText(value); setConsoleOpen(false); requestAnimationFrame(() => dockInput.current?.focus()); };
  return (
    <div className="workbench-shell">
      <header className="appbar">
        <div className="app-brand"><BrandMark /><span>Woga.</span></div>
        <div className="app-mode mono">{policyView(presentedState).run ? "frozen run" : state.mode} <span>/</span> v{policyView(presentedState).revision.toString().padStart(2, "0")}</div>
        <div className="appbar-actions">
          {activeWatchCount > 0 && <button className="monitor-indicator mono" aria-label={`Watching ${activeWatchCount}`} title={`${activeWatchCount} active policy monitor${activeWatchCount === 1 ? "" : "s"}`} onClick={() => { setCapabilitiesOpen(true); setProofOpen(false); }}><Activity size={12} /><span className="monitor-label">Watching</span><span>{activeWatchCount}</span></button>}
          {frozenRun && <button className="draft-control" onClick={() => setShowDraft(value => !value)} aria-label={showDraft ? "Show frozen execution policy" : "Show current draft policy"} title={showDraft ? "Show frozen execution policy" : "Show current draft policy"}><span className="desktop-control-label">{showDraft ? "Frozen run" : "Draft policy"}</span><span className="mobile-control-label">{showDraft ? "Frozen" : "Draft"}</span></button>}
          <div className="header-signal"><LiveSignal mode={signalMode} microphone={captureSnapshot} voiceStatus={voice.status} /></div>
          <button className="proof-control" onClick={() => { setProofOpen(value => !value); setCapabilitiesOpen(false); setResponseOpen(false); }} aria-label="Proof" aria-pressed={proofOpen} title="Provenance and execution proof · I"><ShieldCheck size={14} /><span>Proof</span></button>
          <button className={`mic-control ${dictating || transcribing ? "on" : ""}`} onClick={toggleVoice} aria-pressed={dictating || transcribing} disabled={voice.status === "checking" || voice.status === "submitting" || !voice.supported} title={voice.supported ? voice.provider === "local" ? "Dictate one command · audio processed by local Whisper · M" : "Dictate one command · your browser speech service may receive audio · M" : voice.error || "Checking voice availability"} aria-label={dictating || transcribing ? "Stop voice dictation" : "Start voice dictation"}>
            {dictating || transcribing ? <Mic size={15} /> : <MicOff size={15} />}
            <span>{transcribing ? "Transcribing" : dictating ? "Listening" : "Mic"}</span>
          </button>
          <button className="clear-control" onClick={() => clearCanvas()} aria-label="Clear canvas" disabled={clearing || busy || running || executingRun || activeWatchCount > 0 || !state.objects.length && !state.conversation.some(c => c.role === "user")} title={activeWatchCount ? "Stop watching before clearing the canvas" : "Clear canvas · contract state is unchanged"}><Eraser size={14} /><span>{clearing ? "Clearing…" : "Clear"}</span></button>
          <span className="app-connection mono"><i className={connected ? "on" : ""} />{connected ? "Connected" : "Reconnecting"}</span>
          <button className="demo-control" aria-label={running ? "Stop demo" : "Run demo"} onClick={running ? stop : start} disabled={!connected}><span className="desktop-control-label">{running ? "Stop demo" : "Run demo"}</span><span className="mobile-control-label">{running ? "Stop" : "Demo"}</span><ArrowRight size={14} /></button>
        </div>
      </header>
      <main className={`workbench ${proofOpen ? "proof-open" : ""}`}>
        <Observatory state={presentedState} signalMode={signalMode} microphone={captureSnapshot} />
        {empty && <section className="canvas-welcome" aria-label="Start composing">
          <span className="mono welcome-eyebrow">Observe / compose / verify</span>
          <h1>Intent, made<br /><em>executable.</em></h1>
          <p>Bring live markets onto your canvas.<br />Compose an action. Follow the evidence on chain.</p>
          <div className="welcome-examples">
            <button onClick={() => composeExample("Show ETH and SOL prices")}>Explore markets<ChevronRight size={14} /></button>
            <button onClick={() => composeExample("Show the grant vault")}>Inspect the vault<ChevronRight size={14} /></button>
          </div>
          <span className="mono welcome-note">Actual sources. Explicit execution.</span>
        </section>}
        {proofOpen && <Inspector state={state} agentStatus={rehearsal} />}
        {capabilitiesOpen && <Capabilities state={state} close={() => setCapabilitiesOpen(false)} stopMonitor={stopMonitor} stopping={stoppingMonitor} voiceProvider={voice.provider} />}
        {responseOpen && <ResponsePanel text={reply} close={() => setResponseOpen(false)} />}
        <div className="command-center">
          {(error || voiceError || microphone.error) ? <div className="command-feedback is-error" role="alert"><span>{error || voiceError || microphone.error}</span><button onClick={() => { setError(""); voice.stop(); microphone.stop(); }} aria-label="Dismiss error"><X size={14} /></button></div> : <div className="command-feedback" role="status" aria-live="polite">
            {(dictating || transcribing || voice.status === "submitting") ? <><p className="last-intent">{voice.interimTranscript || voice.finalTranscript || (transcribing ? "Transcribing command…" : voice.status === "requesting" ? "Starting dictation…" : "Speak a command…")}</p><div className="voice-notice">{voice.status === "submitting" ? "Submitting recognized command" : voice.provider === "local" ? "Local Whisper · recorded audio processed by this workspace" : "Browser speech recognition · audio may be processed remotely"}</div></> : <>{prompt && <p className="last-intent" title={prompt}>{prompt}</p>}{reply && <><div className="command-response"><InlineSummary text={caption} /></div><button className="response-read" onClick={() => { setResponseOpen(value => !value); setProofOpen(false); setCapabilitiesOpen(false); }} aria-expanded={responseOpen}>Read response <ArrowUpRight size={10} /></button></>}</>}
          </div>}
          <form className={`command-dock ${busy || executingRun ? "is-working" : ""}`} onSubmit={event => { event.preventDefault(); void submit(text); }}>
            <Command size={16} className="command-symbol" />
            <input ref={dockInput} value={text} onChange={event => setText(event.target.value)} placeholder="Describe what you want to compose…" aria-label="Compose an instruction" disabled={!connected || busy || clearing} />
            <button type="submit" aria-label="Send instruction" disabled={!connected || busy || clearing || !text.trim()}>{busy ? <LoaderCircle className="loading-spinner" size={17} /> : <ArrowRight size={18} />}</button>
          </form>
          <div className="command-hints mono"><span>{busy ? "Interpreting instruction" : executingRun ? "Verifying execution" : transcribing ? "Transcribing voice" : voice.status === "checking" ? "Checking voice" : !voice.supported ? "Voice unavailable · type a command" : "Live canvas"}</span><button onClick={() => { setConsoleOpen(true); requestAnimationFrame(() => input.current?.focus()); }}>Expand prompt <kbd>/</kbd></button></div>
        </div>
      </main>
      <PolicyStrip state={presentedState} watch={watchPolicy} watching={watching} />
      <footer className="app-footer">
        <button className="capabilities-control mono" onClick={() => { setCapabilitiesOpen(value => !value); setProofOpen(false); setResponseOpen(false); }} aria-expanded={capabilitiesOpen}>{state.capabilities.vault.toLowerCase().includes("anvil") ? "Local EVM / Anvil" : state.capabilities.vault}<ArrowUpRight size={11} /></button>
        <span className="mono">{state.objects.filter(o => o.visible).length} objects / {state.runs.length} runs</span>
      </footer>
      {consoleOpen && (
        <div className="prompt-overlay" role="dialog" aria-modal="true" aria-label="Compose a prompt" onClick={event => { if (event.target === event.currentTarget) { setConsoleOpen(false); dockInput.current?.focus(); } }} onKeyDown={event => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
          const first = focusable[0], last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
          <form
            className="prompt-panel"
            onSubmit={(e) => {
              e.preventDefault();
              submit(text);
            }}
          >
            <div className="mono prompt-label">
              Compose a prompt <button type="button" onClick={() => setConsoleOpen(false)} aria-label="Close prompt"><X size={16} /></button>
            </div>
            <input
              ref={input}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What should happen, and when?"
              aria-label="Prompt"
              disabled={busy}
            />
            <div className="prompt-instructions">
              <span>Live sources · composable policies · verified transactions</span>
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
