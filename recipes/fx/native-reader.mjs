export function readNative(bytes, emit, unread) {
  let expected = 1, task, closed = false, offset = 0, lineNumber = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset), record = bytes.subarray(offset, newline < 0 ? bytes.length : newline);
    offset = newline < 0 ? bytes.length : newline + 1;
    lineNumber++;
    try {
      if (newline < 0) throw new Error("Torn final record");
      const line = new TextDecoder("utf-8", { fatal: true }).decode(record);
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
      if (lineNumber === 1 && row.kind !== "session_created") throw new Error("Missing session_created");
      if (row.kind === "session_created") task = row.id;
      const fields = { ts: { wall: new Date(row.ts).toISOString() }, task, source_line: lineNumber };
      if (row.kind === "item") {
        if (!["user", "runtime_context", "context_note", "assistant_running", "assistant", "tool_running", "tool_call", "tool_result", "steering", "turn_end", "interrupted", "context_checkpoint", "file_review", "interruption", "superseded"].includes(row.type)) {
          unread(row.type, "Unknown native item type", lineNumber);
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
      } else unread(row.kind, "Unknown native record kind", lineNumber);
    } catch (error) {
      unread("native", error.message, lineNumber);
      return;
    }
  }
  if (!closed) unread("native", "Session has no closed record", lineNumber + 1);
}
