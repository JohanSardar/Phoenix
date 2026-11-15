import type { TraceEvent } from "@phoenix/formats";
import { decodeHttpHead, decodeJson, type HttpRequest, type Surface } from "@phoenix/wire";
import { httpShape, mcpShape, toCall } from "./normalize.ts";
import type { CallMessage, ConnectorPolicy, Exchange, ExchangeIndex, Provenance, WireMessage } from "./types.ts";

export type StartPoint = "beginning" | "echo" | { at: string };

const eventId = (e: TraceEvent): string => e.id ?? `${e.stream}:${e.seq}`;

interface Paired {
  call: TraceEvent;
  result: TraceEvent;
  surface: Surface;
  op: string;
  args: unknown;
  request: CallMessage;
  response: WireMessage;
  during: { message: Uint8Array; reply?: Uint8Array }[];
}

async function pairMcp(list: readonly TraceEvent[], body: (e: TraceEvent) => Promise<Uint8Array>, notifications: Set<string>): Promise<Paired[]> {
  const paired: Paired[] = [];
  let unsolicited: { message: Uint8Array; reply?: Uint8Array }[] = [];
  const open = new Map<string, Omit<Paired, "result" | "response">>();
  const order: Omit<Paired, "result" | "response">[] = [];
  const awaitingReply = new Map<string, { message: Uint8Array; reply?: Uint8Array }>();
  for (const event of list) {
    const bytes = await body(event);
    const shape = mcpShape(bytes);
    if (!shape || event.partial) continue;
    const { message } = shape;
    const id = JSON.stringify(message.id);
    if (event.kind === "call" && message.method && "id" in message) {
      const draft = { call: event, surface: "mcp" as const, op: shape.op!, args: shape.args, request: { body: bytes }, during: unsolicited };
      unsolicited = [];
      open.set(id, draft); order.push(draft);
    } else if (event.kind === "call" && message.method) {
      notifications.add(message.method);
    } else if (event.kind === "call" && !message.method && awaitingReply.has(id)) {
      awaitingReply.get(id)!.reply = bytes;
      awaitingReply.delete(id);
    } else if (event.kind === "result" && !message.method && open.has(id)) {
      const draft = open.get(id)!;
      open.delete(id);
      order.splice(order.indexOf(draft), 1);
      paired.push({ ...draft, result: event, response: { body: bytes } });
    } else if (event.kind === "result" && message.method) {
      const during: { message: Uint8Array; reply?: Uint8Array } = { message: bytes };
      (order.at(-1)?.during ?? unsolicited).push(during);
      if ("id" in message) awaitingReply.set(id, during);
    }
  }
  return paired;
}

async function pairHttp(list: readonly TraceEvent[], body: (e: TraceEvent) => Promise<Uint8Array>): Promise<Paired[]> {
  const call = list.find(e => e.kind === "call");
  const result = list.find(e => e.kind === "result");
  const [requestMeta, responseMeta] = list.filter(e => e.kind === "meta");
  if (!call || !result || !requestMeta || !responseMeta || call.partial || result.partial) return [];
  const head = decodeJson(await body(requestMeta));
  if (!head.ok) return [];
  const request = { body: await body(call), head: head.value as HttpRequest };
  const shape = httpShape(request.head, request.body);
  const encoding = result.body?.content_encoding;
  return [{
    call, result, surface: "http", op: shape.op, args: shape.args, request, during: [],
    response: { body: await body(result), head: decodeHttpHead(await body(responseMeta)), ...(encoding ? { contentEncoding: encoding } : {}) },
  }];
}

export async function buildIndex(events: readonly TraceEvent[], options: {
  body(event: TraceEvent): Promise<Uint8Array>;
  policy(connector: string): ConnectorPolicy;
  start: StartPoint;
  startTime?: string;
}): Promise<ExchangeIndex> {
  const at = typeof options.start === "object" ? options.start.at : undefined;
  const cut = options.start === "beginning" ? 0 : at === undefined ? events.length : events.findIndex(e => eventId(e) === at);
  if (cut < 0) throw new Error(`Start point is not an event of this run: ${at}`);
  const streams = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (!event.surface || !event.connector || !["call", "result", "meta"].includes(event.kind)) continue;
    streams.set(event.stream, [...streams.get(event.stream) ?? [], event]);
  }
  const paired: Paired[] = [];
  const notifications = new Map<string, Set<string>>();
  for (const list of streams.values()) {
    const connector = list[0]!.connector!;
    if (!notifications.has(connector)) notifications.set(connector, new Set());
    if (list[0]!.surface === "mcp") paired.push(...await pairMcp(list, options.body, notifications.get(connector)!));
    else if (list[0]!.surface === "http") paired.push(...await pairHttp(list, options.body));
  }
  const position = new Map(events.map((e, i) => [e, i] as const));
  const drafts = paired.map(p => {
    const call = toCall({ surface: p.surface, layer: p.call.layer, connector: p.call.connector!, op: p.op, args: p.args, raw: p.request }, options.policy(p.call.connector!));
    return { p, call, position: position.get(p.call)!, completed: position.get(p.result)! };
  }).sort((a, b) => a.position - b.position);
  const writes = drafts.filter(d => !d.call.readOnly).sort((a, b) => a.completed - b.completed);
  const exchanges: Exchange[] = drafts.map(({ p, call, position, completed }) => ({
    id: eventId(p.call), surface: call.surface, layer: call.layer, connector: call.connector, op: call.op, args: call.args, key: call.key, readOnly: call.readOnly,
    history: writes.filter(w => w.call.connector === call.connector && w.completed < position).map(w => w.call.key),
    frozen: completed < cut, position, completed, observedAt: p.result.ts.wall,
    provenance: (p.result.provenance === "derived" || p.result.provenance === "synthesized" ? p.result.provenance : "recorded") as Provenance,
    request: p.request, response: p.response, during: p.during,
  }));
  const startTime = options.startTime ?? events[0]?.ts.wall ?? new Date(0).toISOString();
  return {
    exchanges, frozen: exchanges.filter(e => e.frozen), continuation: exchanges.filter(e => !e.frozen), notifications, startTime,
    cutTime: cut === 0 ? startTime : events[Math.min(cut, events.length - 1)]!.ts.wall,
  };
}
