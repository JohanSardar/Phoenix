import { validate, type TraceEvent } from "@phoenix/formats";
import { canonicalJson, decodeCliInvocation, decodeModelBody, modelDialects, object } from "@phoenix/wire";

export interface Action {
  tool: string;
  args: unknown;
  event: string;
  at: number;
  order: number;
}

export interface EvidenceInput {
  trace: readonly TraceEvent[];
  startAfter?: string;
  blobs?: Readonly<Record<string, string>>;
}

export interface CheckEvidence {
  error?: string;
  trace: readonly TraceEvent[];
  actions: Action[];
  endStates: Record<string, { value: unknown; at: number }>;
  finalText?: { value: string; at: number };
  firstSynthesized?: number;
  notes: string[];
}

export const eventId = (event: TraceEvent): string => event.id ?? `${event.stream}:${event.seq}`;

export function bodyText(event: TraceEvent, blobs: EvidenceInput["blobs"]): string {
  if (!event.body) throw new Error(`Missing body: ${eventId(event)}`);
  if ("inline" in event.body) return event.body.inline;
  const text = blobs?.[event.body.blob];
  if (text === undefined) throw new Error(`Missing blob: ${event.body.blob}`);
  return text;
}

function modelText(value: unknown): string {
  if (Array.isArray(value)) return value.map(modelText).join("");
  if (value === null || typeof value !== "object") return "";
  const v = object(value);
  if (["text", "output_text"].includes(v.type as string) && typeof v.text === "string") return v.text;
  if (v.type === "text_delta" && typeof v.text === "string") return v.text;
  if (v.type === "response.output_text.delta" && typeof v.delta === "string") return v.delta;
  if (typeof v.text === "string" && Object.keys(v).length === 1) return v.text;
  if (typeof v.content === "string" && (v.role === "assistant" || v.role === undefined && v.type === undefined)) return v.content;
  return [v.content, v.output, v.choices, v.message, v.delta, v.candidates, v.parts].map(modelText).join("");
}

export function collectEvidence(input: EvidenceInput, scope: "run" | "continuation"): CheckEvidence {
  for (const event of input.trace) {
    const result = validate("trace", event);
    if (!result.ok) throw new Error(result.errors.join("; "));
  }
  const cut = input.startAfter === undefined ? -1 : input.trace.findIndex(e => eventId(e) === input.startAfter);
  if (input.startAfter !== undefined && cut < 0) throw new Error(`Start point not in trace: ${input.startAfter}`);
  const trace = scope === "run" ? [...input.trace] : input.trace.slice(cut + 1);
  const evidence: CheckEvidence = { trace, actions: [], endStates: {}, notes: [] };
  if (scope === "continuation" && input.trace.slice(0, cut + 1).some(e => e.kind === "result" && e.provenance === "synthesized")) evidence.firstSynthesized = -1;
  const taps: Action[] = [];
  const model: Action[] = [];
  const modelTurns: number[] = [];
  for (const [at, event] of trace.entries()) {
    if (event.kind === "result" && event.provenance === "synthesized" && evidence.firstSynthesized === undefined) evidence.firstSynthesized = at;
    if (event.layer === "under") continue;
    if (event.kind === "meta" && event.op === "end_state" && event.connector) {
      evidence.endStates[event.connector] = { value: JSON.parse(bodyText(event, input.blobs)), at };
    }
    if (event.kind === "meta" && event.op === "final_text") evidence.finalText = { value: bodyText(event, input.blobs), at };
    const [method, ...path] = (event.op ?? "").split(" ");
    const dialect = Object.values(modelDialects).find(d => d.isInference(method ?? "", path.join(" ")));
    if (dialect) {
      if (event.kind !== "result") continue;
      if (event.partial) throw new Error(`Partial model evidence: ${eventId(event)}`);
      const text = bodyText(event, input.blobs);
      const decoded = decodeModelBody(new TextEncoder().encode(text), /^\s*(event:|data:)/.test(text) ? "text/event-stream" : "application/json");
      if (!decoded.ok) throw new Error(`Undecodable model evidence: ${eventId(event)}: ${decoded.why}`);
      modelTurns.push(at);
      for (const [position, use] of dialect.toolUses(decoded.value).filter(u => u.name && !("result" in u)).entries()) {
        model.push({ tool: use.name!, args: use.args ?? {}, event: eventId(event), at, order: at + position / 1000000 });
      }
      const value = modelText(decoded.value);
      if (value) evidence.finalText = { value, at };
      continue;
    }
    if (event.kind !== "call" || event.layer !== "agent" || !event.connector || !event.op) continue;
    if (event.partial) throw new Error(`Partial action evidence: ${eventId(event)}`);
    const text = bodyText(event, input.blobs);
    let args: unknown;
    let name = event.op;
    if (event.surface === "mcp") {
      if (!event.op.startsWith("tools/call:")) continue;
      const rpc = object(JSON.parse(text));
      name = event.op.slice("tools/call:".length);
      args = object(rpc.params).arguments ?? {};
    } else if (event.surface === "cli") args = decodeCliInvocation(new TextEncoder().encode(text));
    else { try { args = JSON.parse(text); } catch { args = text; } }
    taps.push({ tool: `${event.connector}.${name}`, args, event: eventId(event), at, order: at });
  }
  const consumed = new Set<Action>();
  const sameTool = (a: string, b: string) => a === b || a.endsWith("." + b) || b.endsWith("." + a);
  for (const action of model) {
    const nextTurn = modelTurns.find(at => at > action.at) ?? Infinity;
    const candidates = taps.filter(tap => !consumed.has(tap) && tap.at > action.at && tap.at < nextTurn && sameTool(tap.tool, action.tool) && canonicalJson(tap.args) === canonicalJson(action.args));
    const competing = model.filter(other => other.at === action.at && sameTool(other.tool, action.tool) && canonicalJson(other.args) === canonicalJson(action.args));
    if (candidates.length === 1 && competing.length === 1) {
      candidates[0]!.order = action.order;
      consumed.add(candidates[0]!);
    } else if (candidates.length || taps.some(tap => sameTool(tap.tool, action.tool) && tap.at > action.at && tap.at < nextTurn)) {
      evidence.notes.push(`Ambiguous model/tap pairing for ${action.tool} at ${action.event}; using tap observation order`);
    } else evidence.actions.push(action);
  }
  for (const at of modelTurns) {
    const nextTurn = modelTurns.find(next => next > at) ?? Infinity;
    const unpairedModel = evidence.actions.filter(action => action.at === at);
    const unpairedTaps = taps.filter(tap => !consumed.has(tap) && tap.at > at && tap.at < nextTurn);
    if (!unpairedModel.length || unpairedModel.length !== unpairedTaps.length) continue;
    evidence.actions = evidence.actions.filter(action => action.at !== at);
    unpairedTaps.forEach(tap => consumed.add(tap));
    evidence.notes.push(`Ambiguous model/tap names at model turn ${at}; using tap observation order`);
  }
  evidence.actions.push(...taps);
  evidence.actions.sort((a, b) => a.order - b.order || a.at - b.at);
  return evidence;
}
