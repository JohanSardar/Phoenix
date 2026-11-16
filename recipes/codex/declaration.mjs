// Codex code mode lists an MCP tool as its description, then "exec tool declaration:" and a TypeScript
// declaration rendered from the tool's input schema. This reads that declaration back into a schema,
// so the stand-in server offers the tool the way the session saw it.

const MARK = "\n\nexec tool declaration:\n```ts\n";

export function toolSchema(fullName, listed) {
  const at = listed.indexOf(MARK);
  if (at < 0) return { description: listed, inputSchema: { type: "object" } };
  const description = listed.slice(0, at);
  const declaration = listed.slice(at + MARK.length);
  const start = declaration.indexOf(`${fullName}(args: `);
  if (start < 0) return { description, inputSchema: { type: "object" } };
  try {
    return { description, inputSchema: type({ text: declaration, at: start + fullName.length + 7 }) };
  } catch {
    return { description, inputSchema: { type: "object" } };
  }
}

const skip = reader => { while (/\s/.test(reader.text[reader.at] ?? "")) reader.at++; };

function expect(reader, token) {
  skip(reader);
  if (!reader.text.startsWith(token, reader.at)) throw new Error(`expected ${token}`);
  reader.at += token.length;
}

function type(reader) {
  const options = [primary(reader)];
  for (skip(reader); reader.text[reader.at] === "|"; skip(reader)) { reader.at++; options.push(primary(reader)); }
  if (options.length === 1) return options[0];
  const nullable = options.some(option => option.type === "null");
  const literals = options.filter(option => "const" in option);
  if (literals.length && literals.length + (nullable ? 1 : 0) === options.length) return { type: nullable ? ["string", "null"] : "string", enum: [...literals.map(option => option.const), ...(nullable ? [null] : [])] };
  if (options.every(option => typeof option.type === "string" && Object.keys(option).length === 1)) return { type: options.map(option => option.type) };
  return { anyOf: options };
}

function primary(reader) {
  skip(reader);
  const rest = reader.text.slice(reader.at);
  if (rest.startsWith("{")) return object(reader);
  if (rest.startsWith("\"")) {
    const end = reader.text.indexOf("\"", reader.at + 1);
    const value = reader.text.slice(reader.at + 1, end);
    reader.at = end + 1;
    return { const: value };
  }
  if (rest.startsWith("Array<")) {
    reader.at += 6;
    const items = type(reader);
    expect(reader, ">");
    return { type: "array", items };
  }
  const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
  if (!word) throw new Error("unknown type");
  reader.at += word.length;
  return ["string", "number", "integer", "boolean", "null"].includes(word) ? { type: word } : {};
}

function object(reader) {
  expect(reader, "{");
  const properties = {};
  const required = [];
  let additional;
  let comment = [];
  for (;;) {
    skip(reader);
    if (reader.text[reader.at] === "}") { reader.at++; break; }
    if (reader.text.startsWith("//", reader.at)) {
      const end = reader.text.indexOf("\n", reader.at);
      comment.push(reader.text.slice(reader.at + 2, end).trim());
      reader.at = end;
      continue;
    }
    if (reader.text[reader.at] === "[") {
      reader.at = reader.text.indexOf("]:", reader.at) + 2;
      additional = type(reader);
    } else {
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*|^"[^"]*"/.exec(reader.text.slice(reader.at))?.[0];
      if (!name) throw new Error("unknown member");
      reader.at += name.length;
      const optional = reader.text[reader.at] === "?";
      if (optional) reader.at++;
      expect(reader, ":");
      const value = type(reader);
      const key = name.startsWith("\"") ? name.slice(1, -1) : name;
      properties[key] = comment.length ? { ...value, description: comment.join("\n") } : value;
      if (!optional) required.push(key);
    }
    comment = [];
    skip(reader);
    if (reader.text[reader.at] === ";" || reader.text[reader.at] === ",") reader.at++;
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), ...(additional ? { additionalProperties: additional } : {}) };
}
