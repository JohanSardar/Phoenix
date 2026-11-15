import { createServer } from "node:net";
import { unlink } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { appendCoverage, appendNote } from "@phoenix/store";
import type { TraceEvent } from "@phoenix/formats";
import type { Copy } from "./tee.ts";

export async function collect(root: string, socketPath: string, home: string) {
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  const workers = new Set<Worker>();
  const server = createServer(socket => {
    let buffer = "", worker: Worker | undefined, busy = false, ended = false;
    const dispatch = () => {
      if (busy) return;
      const end = buffer.indexOf("\n");
      if (end < 0) { if (ended) worker?.postMessage({ type: "disconnect" }); else socket.resume(); return; }
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let copy: Copy;
      try { copy = JSON.parse(line) as Copy; } catch { socket.destroy(); return; }
      if ((copy.type as string) === "note") { void appendNote(root, (copy as unknown as { event: TraceEvent }).event).catch(() => {}); socket.end(); return; }
      if (!worker) {
        if (copy.type !== "open" || !/^[a-zA-Z0-9_-]+$/.test(copy.stream)) { socket.destroy(); return; }
        worker = new Worker(new URL("./collector-worker.ts", import.meta.url), { workerData: { root, home, stream: copy.stream } });
        workers.add(worker);
        worker.on("message", () => { busy = false; dispatch(); });
        worker.on("error", () => { socket.destroy(); });
        worker.on("exit", () => { workers.delete(worker!); socket.destroy(); });
      }
      busy = true; socket.pause(); worker.postMessage(copy);
    };
    socket.on("data", (bytes: Buffer) => {
      buffer += bytes.toString();
      if (buffer.length > 4 * 1024 * 1024) { socket.destroy(); return; }
      dispatch();
    });
    socket.on("end", () => { ended = true; dispatch(); });
    socket.on("error", () => {});
    socket.on("close", () => { ended = true; dispatch(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await appendCoverage(root, { collector: process.pid, state: "ready", at: new Date().toISOString() });
  return { async close() {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([...workers].map(worker => new Promise<void>(resolve => worker.once("exit", () => resolve()))));
    await unlink(socketPath).catch(() => {});
  } };
}
