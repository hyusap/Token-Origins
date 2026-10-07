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
import { displayReply } from "./display-reply";
import { policyView, frozenGraph, runOutcome, decisionRole, settledExecutionReply } from "./policy-view";
import { describeGraph, describeSource } from "./policy-language";

const money = (n: number | undefined) =>
  typeof n === "number" && Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 8,
      }).format(n)
    : "—";
const short = (s?: string, size = 6) =>
  s ? `${s.slice(0, size + 2)}…${s.slice(-size)}` : "Awaiting deployment";
const clock = (s?: string) =>
  s ? new Date(s).toLocaleTimeString("en-GB", { hour12: false }) : "—";
const fixtureName = import.meta.env.DEV ? new URLSearchParams(location.search).get("fixture") : null;
const fixtureLoaders = import.meta.env.DEV ? import.meta.glob("../fixtures/states/*.json") : {};
const api = async (path: string, body?: unknown) => {
  if (fixtureName) throw new Error("Fixture preview is read-only.");
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

function useCanvas() {
  const [state, setState] = useState<CanvasState | null>(null);
  const [connected, setConnected] = useState(false);
  const applyState = (next: CanvasState) => setState(previous => !previous || next.sessionId !== previous.sessionId || next.seq >= previous.seq ? next : previous);
  const acknowledged = useRef(new Set<string>());
  useEffect(() => {
    if (fixtureName) {
      let active = true;
      const loader = fixtureLoaders[`../fixtures/states/${fixtureName}.json`];
      if (loader) void loader().then((fixture: any) => {
        if (active) { applyState(fixture.state || fixture.default.state); setConnected(true); }
      });
      return () => { active = false; };
    }
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
  return <div className={`live-signal ${microphone.status === "live" ? "mic-live" : ""}`} role="status" aria-label={microphone.status === "live" ? "Microphone live" : "Microphone off"}>
    <canvas ref={canvas} aria-hidden="true" />
    <span className="signal-caption mono"><i />{microphone.status === "live" ? "Mic live" : microphone.status === "requesting" ? "Mic permission…" : "Mic off"}</span>
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
            ? (Date.now() - Date.parse(object.provenance.observedAt)) / 1000 > 26 * 3600
              ? "oracle-age is-stale"
              : "oracle-age"
            : undefined
        }
      >
        {object.kind === "feed"
          ? <ObservationAge observedAt={object.provenance.observedAt} />
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
  if (!Number.isFinite(Number(object.data.price))) return <p className="policy-restriction">No source reading archived or fetched yet.</p>;
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
        {object.data.network && <p className="mono policy-restriction">{object.data.network} · chain {object.data.chainId}</p>}
        {object.provenance.address && <p className="mono policy-restriction observation-address" title={object.provenance.address}>{short(object.provenance.address,8)}</p>}
        {object.provenance.observedAt && <ObservationAge observedAt={object.provenance.observedAt} />}
        <p className="policy-restriction">
          {object.kind === "price" && object.id !== "price:eth-usd"
            ? "Observation only. This execution backend supports ETH-USD exchange triggers; configured Chainlink feeds can also be composed."
            : object.provenance.label === "Archived execution observation" ? "Frozen execution input." : "Use this source in a composed policy."}
        </p>
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
    <div className="node-foot mono">{root ? "Policy verdict is checked with mandatory guards" : "A false branch can be valid inside OR or NOT"}</div>
  </article>;
}
function ActionNode({ state, focused }: { state:CanvasState; focused:boolean }) {
  const view = policyView(state);
  const sell = view.graph.action.type === "sell";
  return <article className={`graph-node action-node ${focused ? "focused" : ""}`} data-object-id="action:pause">
    <NodeHeader index="04" type={sell ? "Simulated action" : "Report action"} />
    <div className="node-body">
      <div className="action-icon"><LockKeyhole size={26} strokeWidth={1} /></div>
      <h3>{view.action}</h3>
      <p>{sell ? "Mock venue rehearsal. No transaction and no asset moved." : "Send a verified policy report to the grant vault."}</p>
    </div>
    <div className="node-foot"><span>{sell ? "Simulation only" : "Receiver-authorized"}</span><ShieldCheck size={13} /></div>
  </article>;
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
function ObservationAge({ observedAt }: {observedAt:string}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const age = (now - Date.parse(observedAt)) / 1000;
  return <span className="mono">{!Number.isFinite(age) ? "Age unavailable" : age < 0 ? `Observed ${Math.ceil(-age)}s ahead` : `Observed ${Math.floor(age)}s ago`}</span>;
}
function RunObservations({run}: {run:ExecutionRun}) {
  return <div className="archived-observations">{run.observations?.map(o =>
    <div className="archived-observation" key={o.key} data-source-key={o.key}>
      <strong>{o.label} · {money(o.usd)}</strong>
      <span>{o.provider}{o.network ? ` · ${o.network}` : ""}{o.chainId ? ` · chain ${o.chainId}` : ""}</span>
      {o.address && <span className="mono observation-address" title={o.address}>{o.address}</span>}
      <span className="mono">{o.observedAt}</span><ObservationAge observedAt={o.observedAt} />
      <span className="mono">Fetched {o.fetchedAt}</span>
      <span className="mono">Raw {o.raw}{o.roundId ? ` · round ${o.roundId}` : ""}</span>
    </div>)}</div>;
}
function RunEvidence({run}: {run:ExecutionRun}) {
  const done = ["confirmed","no-op","failed"].includes(run.status);
  const simulated = run.evidence?.simulatedOrder;
  const onchain = !simulated && !!run.evidence?.transactionHash;
  return <section className={`run-evidence nowheel nopan ${done ? "settled" : ""}`} aria-label="Execution evidence" data-object-id={`run:${run.id}`}>
    <div className="evidence-title"><span className="mono">Frozen run / v{run.revision.toString().padStart(2,"0")}</span>
      <span className={`status-${run.status}`}>{run.uncertain ? "Checking chain" : simulated ? "Simulated" : run.status}</span>
    </div>
    <div className="frozen-rule"><span className="mono">Frozen policy</span><p>{policyViewForRun(run)}</p></div>
    <p className={run.status === "failed" ? "execution-error" : "run-outcome"}>{runOutcome(run)}</p>
    <RunObservations run={run} />
    <div className="evidence-details">{run.decisions.map((d,index) => {
      const role = decisionRole(d);
      const failed = !d.passed && role !== "node";
      return <div className={`decision decision-${role}`} key={`${d.nodeId || d.id}:${index}`} data-result-role={role}>
        <span className={failed ? "fail" : d.passed ? "pass" : "intermediate-false"}>{d.passed ? <Check size={12} /> : failed ? <X size={12} /> : <Circle size={12} />}</span>
        <span title={d.detail}><span className="result-role mono">{role === "root" ? "Policy verdict" : role === "guard" ? "Mandatory check" : "Intermediate"}</span>{d.detail}</span>
        <span className="mono">{d.passed ? "TRUE" : "FALSE"}</span>
      </div>;
    })}</div>
    {simulated && <div className="simulation-receipt"><strong>Simulated sell of {simulated.amount} {simulated.symbol}</strong><p>{simulated.venue} · reference {money(simulated.referencePriceUsd)} · notional {money(simulated.notionalUsd)}</p><span>No transaction, no asset moved.</span></div>}
    {onchain && <div className="receipt">
      {run.evidence?.explorerUrl ? <a href={run.evidence.explorerUrl} target="_blank" rel="noreferrer" className="mono">{short(run.evidence.transactionHash,9)}</a> : <span className="mono">{short(run.evidence?.transactionHash,9)}</span>}
      {run.evidence?.blockNumber && <span>Block {run.evidence.blockNumber}</span>}
      <span>{run.status === "confirmed" ? "Vault pause verified" : "Write awaiting verification"}</span>
    </div>}
    {run.policyHash && <div className="policy-hash mono" title={run.policyHash}>Policy {short(run.policyHash,8)}</div>}
    <div className="evidence-footer mono">{run.executionMode}<span>{clock(run.startedAt)}</span></div>
  </section>;
}
function policyViewForRun(run:ExecutionRun) {
  return describeGraph(frozenGraph(run));
}

function Instrument({ data }: NodeProps<InstrumentFlowNode>) {
  const { kind, state, focused, object, run, graphNode } = data;
  if (kind === "section") return <div className="flow-section mono">{data.title}</div>;
  return <div className={`flow-instrument ${focused ? "in-focus" : ""} ${data.lane === "markets" && state.workflow.created ? "market-observation" : ""}`}>
    {kind === "price" && object && <PriceNode object={object} focused={focused} />}
    {kind === "vault" && object && <VaultNode object={object} focused={focused} />}
    {kind === "source" && object && <SourceNode object={object} />}
    {kind === "conditions" && graphNode && <PolicyCondition state={state} node={graphNode} focused={focused} />}
    {kind === "action" && <ActionNode state={state} focused={focused} />}
    {kind === "run" && run && <RunEvidence run={run} />}
    {kind === "conditions" ? <>
      <Handle type="target" position={Position.Left} id="in" style={{ top:110 }} isConnectable={false} />
      <Handle type="source" position={Position.Right} id="out" style={{ top:110 }} isConnectable={false} />
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
function FlowCanvas({ state, signalMode, microphone }: { state: CanvasState; signalMode: SignalMode; microphone: MicrophoneSnapshot }) {
  const graph = useMemo(() => canvasFlow(state), [state]);
  const [nodes, setNodes, onNodesChange] = useNodesState<InstrumentFlowNode>(graph.nodes);
  const flow = useReactFlow<InstrumentFlowNode>();
  const initialized = useNodesInitialized();
  const wrap = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const lastView = useRef("");
  const lastNodeIds = useRef<Set<string> | null>(null);
  const lastSession = useRef(state.sessionId);
  const currentState = useRef(state);
  currentState.current = state;
  useEffect(() => {
    if (lastSession.current !== state.sessionId) {
      lastSession.current = state.sessionId; lastView.current = "";
      lastNodeIds.current = null;
      flow.setViewport({ x: 0, y: 0, zoom: 1 });
    }
    setNodes(previous => reconcileCanvasNodes(previous, graph.nodes));
  }, [graph, setNodes, flow, state.sessionId]);
  const fit = (markets = false) => {
    const lane = markets ? "markets" : state.workflow.created ? "policy" : null;
    return flow.fitView({ ...FLOW_FIT, nodes: nodes.filter(node => !lane || node.data.lane === lane).map(node => ({ id: node.id })) });
  };
  const navigate = (action: string) => {
    if (action === "fit") { void fit(); return; }
    if (action === "zoom_in") { void flow.zoomIn({ duration: 250 }); return; }
    if (action === "zoom_out") { void flow.zoomOut({ duration: 250 }); return; }
    const viewport = flow.getViewport();
    const delta = 160;
    void flow.setViewport({ ...viewport, x: viewport.x + (action === "pan_left" ? delta : action === "pan_right" ? -delta : 0), y: viewport.y + (action === "pan_up" ? delta : action === "pan_down" ? -delta : 0) }, { duration: 250 });
  };
  useEffect(() => {
    // State arrives before the controlled nodes are reconciled. Do not consume
    // navigation until React Flow has the current layout and measured cards.
    if (!initialized || !nodes.length || nodes.some(node => node.data.state !== state)) return;
    const cards = nodes.filter(node => node.data.kind !== "section");
    const added = lastNodeIds.current ? cards.filter(node => !lastNodeIds.current!.has(node.id)) : [];
    lastNodeIds.current = new Set(cards.map(node => node.id));
    const key = `${state.sessionId}:${state.canvasView?.sequence || 0}:${state.focus.objectId}:${state.workflow.created}:${cards.map(node => node.id).join(",")}`;
    if (lastView.current === key) return;
    lastView.current = key;
    // New content should be visible even when discovery leaves semantic focus
    // and the navigation sequence unchanged. Frame new cards after measurement.
    if (added.length) {
      if (added.some(node => node.data.kind === "conditions" || node.data.kind === "action")) void fit();
      else void flow.fitView({ ...FLOW_FIT, nodes: added.map(node => ({ id: node.id })) });
      return;
    }
    const action = state.canvasView?.action || (state.focus.objectId?.startsWith("run:") ? "focus" : "fit");
    if (action !== "focus") { navigate(action); return; }
    const id = state.focus.objectId;
    const node = id ? flow.getNode(id) : null;
    if (!node || state.focus.objectId?.startsWith("workflow")) { void fit(); return; }
    const w = wrap.current?.clientWidth || 1000;
    const scale = Math.min(1.1, Math.max(.65, w / 1100));
    const width = node.measured?.width || Number(node.style?.width) || 330;
    const height = node.measured?.height || 240;
    void flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: scale, duration: 500 });
  }, [initialized, state, nodes]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest("input, textarea, .inspector") || event.metaKey || event.ctrlKey) return;
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
    <div className="flow-metadata mono"><span>Treasury</span><div className="flow-view-actions">
      {state.workflow.created && <button onClick={() => void fit()}>Active policy</button>}
      {nodes.some(node => node.data.lane === "markets") && <button onClick={() => void fit(true)}>Market observations</button>}
      <span>{state.focus.objectId ? `Focused: ${state.focus.label}` : "No focus"}</span>
    </div></div>
    <span className="flow-zoom mono">{Math.round(zoom * 100)}% · + − zoom · 0 fit</span>
    {state.clarification && <div className="clarification"><span className="mono">Clarify</span><h3>{state.clarification.question}</h3><div>{state.clarification.candidates.map(id => <span key={id}>{state.objects.find(o => o.id === id)?.label || id}</span>)}</div></div>}
  </div>;
}
function Observatory(props: { state: CanvasState; signalMode: SignalMode; microphone: MicrophoneSnapshot }) {
  return <ReactFlowProvider><FlowCanvas {...props} /></ReactFlowProvider>;
}
function PolicyStrip({ state }: { state: CanvasState }) {
  const view = policyView(state);
  if (!state.workflow.created && !view.run) return null;
  return <div className="policy-line">
    <span className="mono">{view.run ? "Frozen run" : "Rule"} / v{view.revision.toString().padStart(2,"0")}</span>
    <p>{view.summary}</p>
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
            <dt>Frozen policy</dt><dd>{policyViewForRun(focusedRun)}</dd>
            <dt>Outcome</dt><dd>{runOutcome(focusedRun)}</dd>
            <dt>Archived observations</dt><dd><RunObservations run={focusedRun} /></dd>
            <dt>Policy hash</dt><dd className="mono">{short(focusedRun.policyHash,8)}</dd>
            {!focusedRun.evidence?.simulatedOrder && focusedRun.evidence?.transactionHash && <>
              <dt>Transaction</dt><dd className="mono">{short(focusedRun.evidence.transactionHash,8)}</dd>
              <dt>Receipt</dt><dd>{focusedRun.evidence.receiptStatus || focusedRun.status}</dd>
              {focusedRun.evidence.blockNumber && <><dt>Block</dt><dd className="mono">{focusedRun.evidence.blockNumber}</dd></>}
            </>}
            {focusedRun.evidence?.verification && (
              <>
                <dt>Execution verification</dt>
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
  const { state, connected, applyState } = useCanvas();
  const [text, setText] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  useEffect(() => {
    if (state?.focus.objectId?.startsWith("run:")) setShowDraft(false);
    else if (state?.focus.objectId?.startsWith("workflow:")) setShowDraft(true);
  }, [state?.inspectedRunId, state?.focus.objectId]);
  const [error, setError] = useState("");
  const [rehearsal, setRehearsal] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const microphone = useMicrophone();
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
  const clearCanvas = async () => {
    if (!state || clearing) return;
    setClearing(true); setError("");
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
    if (fixtureName) return;
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
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [rehearsal, state?.sessionId, clearing, microphone.status]);
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
  const executingRun = state.runs.some(run => run.uncertain || !["confirmed", "failed", "no-op"].includes(run.status));
  const signalMode: SignalMode = !connected ? "offline" : error || microphone.error ? "blocked" : executingRun ? "running" : busy ? "working" : consoleOpen ? "typing" : "ready";
  const presentedState: CanvasState = showDraft ? {...state,inspectedRunId:undefined,
    focus:state.focus.objectId?.startsWith("run:") ? {objectId:"workflow:treasury",label:"Draft policy"} : state.focus} : state;
  const running = rehearsal?.running || rehearsal?.status === "running";
  const lastPrompt = state.conversation.filter(entry => entry.role === "user").at(-1)?.text || state.activity.prompt;
  const completion = displayReply(settledExecutionReply(state,state.activity.summary) || state.activity.summary);
  return (
    <div className="workbench-shell">
      <header className="appbar">
        <div className="app-brand"><BrandMark /><span>Sotto.</span></div>
        <div className="app-mode mono">{policyView(presentedState).run ? "run" : state.mode} <span>/</span> v{policyView(presentedState).revision.toString().padStart(2, "0")}</div>
        <div className="appbar-actions">
          <div className="header-signal"><LiveSignal mode={signalMode} microphone={microphone} /></div>
          <button className={`mic-control ${microphone.status === "live" ? "on" : ""}`} onClick={microphone.toggle} aria-pressed={microphone.status === "live"} title="Microphone waveform · local audio only · M">
            {microphone.status === "live" ? <Mic size={15} /> : <MicOff size={15} />}
            <span>{microphone.status === "live" ? "Mic on" : microphone.status === "requesting" ? "Cancel mic" : "Mic"}</span>
          </button>
          <button className="clear-control" onClick={() => clearCanvas()} disabled={!!fixtureName || clearing || busy || running || executingRun || !state.objects.length && !state.conversation.some(c => c.role === "user")} title="Clear canvas · contract state is unchanged"><Eraser size={14} /><span>{clearing ? "Clearing…" : "Clear"}</span></button>
          <span className="app-connection mono"><i className={connected ? "on" : ""} />{connected ? "Connected" : "Reconnecting"}</span>
          {policyView(state).run && <button className="proof-control" onClick={() => setShowDraft(value => !value)}>{showDraft ? "Frozen run" : "Draft policy"}</button>}
          <button className="proof-control" onClick={() => setProofOpen(value => !value)} aria-pressed={proofOpen}>Proof</button>
          <button className="demo-control" onClick={running ? stop : start} disabled={!connected || !!fixtureName}>{running ? "Stop demo" : "Run demo"}<ArrowRight size={14} /></button>
        </div>
      </header>
      {fixtureName && <div className="fixture-banner">Read-only fixture · {fixtureName}</div>}
      <main className={`workbench ${proofOpen ? "proof-open" : ""}`}>
        <Observatory state={presentedState} signalMode={signalMode} microphone={microphone} />
        {proofOpen && <Inspector state={presentedState} agentStatus={rehearsal} />}
        {(error || microphone.error) && <div className="command-center" role="alert">{error || microphone.error}</div>}
      </main>
      {(lastPrompt || completion) && <div className="conversation-caption" aria-live="polite" aria-atomic="true">
        {lastPrompt && <p className="utterance-caption"><span className="mono">You</span>{lastPrompt}</p>}
        {completion && <p className="completion-caption"><span className="mono">Sotto</span><InlineSummary text={completion} /></p>}
      </div>}
      <PolicyStrip state={presentedState} />
      <footer className="app-footer">
        <span className="mono">{state.capabilities.vault.toLowerCase().includes("anvil") ? "Local EVM / Anvil" : state.capabilities.vault}</span>
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
              Prompt
            </div>
            <input
              ref={input}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Enter a prompt"
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
