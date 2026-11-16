import type { Readable, Writable } from "node:stream";
import type { EngineChannel } from "./channel.ts";

export interface Mount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ClockReport {
  clock: "virtual" | "real" | "unknown";
  probe?: CommandResult;
  binaries: { path: string; clock: "real" | "unknown" }[];
}

export interface SandboxSpec {
  image: string;
  argv: string[];
  env: Record<string, string>;
  mounts: Mount[];
  clockFile: string;
  workdir?: string;
  clockProbe?: string[];
  clockBinaries?: string[];
  virtualTime?: string;
  faketimeLibrary?: string;
  dontFakeMonotonic?: boolean;
}

export interface SandboxProcess {
  id: string;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  interrupted: Promise<Error>;
  clock: ClockReport;
  exec(argv: string[]): Promise<CommandResult>;
  stop(): Promise<void>;
}

export interface Sandbox {
  start(spec: SandboxSpec): Promise<{ process: SandboxProcess; channel: EngineChannel }>;
}
