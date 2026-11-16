export function readNative(text, emit, unread) {
  let expected = 1, task, closed = false;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line && index === lines.length - 1) continue;
    try {
      if (index === lines.length - 1) throw new Error("Torn final record");
      const suffix = /,"crc":"([0-9a-f]{8})"}$/.exec(line);
      if (!suffix) throw new Error("Missing native checksum");
      let crc = 0xffffffff;
      for (const byte of Buffer.from(line.slice(0, suffix.index))) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? crc >>> 1 ^ 0x82f63b78 : crc >>> 1;
      }
      if (((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0") !== suffix[1]) throw new Error("Native checksum mismatch");
      const row = JSON.parse(line);
      if (row.v !== 1 || row.seq !== expected++ || !Number.isFinite(row.ts)) throw new Error("Unsupported or out-of-order native record");
      if (index === 0 && row.kind !== "session_created") throw new Error("Missing session_created");
      if (row.kind === "session_created") task = row.id;
      const fields = { ts: { wall: new Date(row.ts).toISOString() }, task };
      if (row.kind === "item") {
        if (!["user", "runtime_context", "context_note", "assistant_running", "assistant", "tool_running", "tool_call", "tool_result", "steering", "turn_end", "interrupted", "context_checkpoint", "file_review"].includes(row.type)) {
          unread(row.type, "Unknown native item type", index + 1);
          continue;
        }
        const data = row.data;
        if (row.type === "tool_call" || row.type === "tool_result") {
          if (typeof data?.call_id !== "string" || typeof data.tool_name !== "string") throw new Error("Missing native tool identity");
          emit(row.type === "tool_call" ? "call" : "result", data.tool_name, data, ["body", "ts.wall", "task", "tool_use_id"], { ...fields, tool_use_id: data.call_id, layer: "agent", ...(row.type === "tool_result" && data.completeness !== "complete" ? { partial: true } : {}) });
        } else emit("meta", `fx.${row.type}`, data, ["body", "ts.wall", "task"], fields);
      } else if (["session_created", "set", "turn_started", "turn_committed", "turn_interrupted", "compacted", "snapshot", "closed", "child_spawned", "child_finished"].includes(row.kind)) {
        emit(row.kind === "closed" ? "close" : "meta", `fx.${row.kind}`, row, ["body", "ts.wall", "task"], fields);
        if (row.kind === "closed") closed = true;
      } else unread(row.kind, "Unknown native record kind", index + 1);
    } catch (error) {
      unread("native", error.message, index + 1);
      return;
    }
  }
  if (!closed) unread("native", "Session has no closed record", lines.length);
}
