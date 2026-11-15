import type { MomentManifest, TraceEvent } from "@phoenix/formats";
import type { HttpRequest, HttpResponse, Surface, WriteHistories } from "@phoenix/wire";
import type { Emulators } from "./emulators.ts";

export type Provenance = NonNullable<TraceEvent["provenance"]>;
export type ConnectorEntry = NonNullable<MomentManifest["connectors"]>[string];
export type ResolverName = NonNullable<ConnectorEntry["skip_resolvers"]>[number];
export interface ConnectorPolicy extends Partial<ConnectorEntry> { volatile?: readonly string[] }

export interface WireMessage {
  body: Uint8Array;
  head?: HttpResponse;
  contentEncoding?: string;
}

export interface CallMessage {
  body: Uint8Array;
  head?: HttpRequest;
}

export interface Call {
  surface: Surface;
  layer: "agent" | "under";
  connector: string;
  op: string;
  args: unknown;
  key: string;
  readOnly: boolean;
  raw: CallMessage;
  history?: readonly string[];
}

export interface Exchange {
  id: string;
  surface: Surface;
  layer: "agent" | "under";
  connector: string;
  op: string;
  args: unknown;
  key: string;
  readOnly: boolean;
  history: readonly string[];
  frozen: boolean;
  position: number;
  completed: number;
  observedAt: string;
  provenance: Provenance;
  request: CallMessage;
  response: WireMessage;
  during: readonly { message: Uint8Array; reply?: Uint8Array }[];
  after: readonly Uint8Array[];
}

export interface Answer {
  raw: WireMessage;
  provenance: Provenance;
  resolver: string;
  note?: string;
  exchange?: Exchange;
}
export type Miss = { miss: true; why: string };

export interface ExchangeIndex {
  exchanges: readonly Exchange[];
  frozen: readonly Exchange[];
  continuation: readonly Exchange[];
  notifications: ReadonlyMap<string, ReadonlySet<string>>;
  startTime: string;
  cutTime: string;
}

export interface ReplayCtx {
  emulators?: Emulators;
  index: ExchangeIndex;
  histories: WriteHistories;
  served: Set<string>;
  policy(connector: string): ConnectorPolicy;
}

export interface Resolver {
  name: ResolverName;
  resolve(call: Call, ctx: ReplayCtx): Promise<Answer | Miss>;
}
