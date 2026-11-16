// Learns mail from himalaya's JSON output: what the session's own himalaya calls printed and what a
// command-line capture read. Envelopes keep their real ids (UIDs per folder), folder and flags; a
// message whose body was read gets that body. A body never read stays unknown, so reading it falls
// through. Plain-text output is not parsed.
import { addresses, buildMessage, decodeWords } from "./mime.mjs";
import { snippetOf } from "./mailbox.mjs";

const SYSTEM = { INBOX: "INBOX", "[Gmail]/Drafts": "DRAFT", "[Gmail]/Important": "IMPORTANT", "[Gmail]/Sent Mail": "SENT", "[Gmail]/Spam": "SPAM", "[Gmail]/Starred": "STARRED", "[Gmail]/Trash": "TRASH", "[Gmail]/All Mail": null };
export const VALUED = new Set(["-f", "--folder", "-o", "--output", "-a", "--account", "-c", "--config", "-H", "--header", "--page", "-s", "--page-size", "-w", "--max-width"]);
export const valued = (argv, option) => VALUED.has(option) || (option === "-p" && argv.includes("envelope"));

function command(argv) {
  const options = {}, words = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    if (eq) { (options[eq[1]] ??= []).push(eq[2]); continue; }
    if (valued(argv, a)) { (options[a] ??= []).push(argv[++i]); continue; }
    if (a.startsWith("-")) { options[a] = [true]; continue; }
    words.push(a);
  }
  const value = (...names) => names.flatMap(n => options[n] ?? []).at(-1);
  return { words, folder: value("-f", "--folder") ?? "INBOX", json: value("-o", "--output") === "json" };
}

function folderLabel(box, folder) {
  const name = folder.toUpperCase() === "INBOX" ? "INBOX" : folder;
  if (name in SYSTEM) return { known: true, label: SYSTEM[name] };
  const user = (box.labels ?? []).find(l => l.labelType === "USER" && l.name === name);
  return user ? { known: true, label: user.labelId } : { known: false };
}

const byUid = (box, folder, uid) => [...box.messages.values()].find(m => m.uids[folder] === uid);
const dateMs = text => { const ms = Date.parse(String(text ?? "").replace(" ", "T")); return Number.isFinite(ms) ? ms : undefined; };

function envelopes(box, folder, list) {
  const place = folderLabel(box, folder);
  if (!place.known || !Array.isArray(list)) return;
  for (const e of list) {
    const uid = Number(e?.id);
    if (!Number.isInteger(uid)) continue;
    const flags = new Set(e.flags ?? []);
    const labels = [...(place.label ? [place.label] : []), ...(flags.has("Seen") ? [] : ["UNREAD"]), ...(flags.has("Flagged") ? ["STARRED"] : [])];
    const ms = dateMs(e.date) ?? box.nowMs ?? 0;
    let m = byUid(box, folder, uid) ?? [...box.messages.values()].find(o => o.uids[folder] === undefined && o.fields.subject === e.subject && o.fields.sender === e.from?.addr && Math.floor(Number(o.internalDate) / 60000) === Math.floor(ms / 60000));
    if (m) m.uids[folder] = uid;
    else {
      const id = box.newId(ms);
      m = { id, threadId: id, labelIds: [], internalDate: String(ms), fields: {}, know: new Set(["metadata"]), observedAt: -1, uids: { [folder]: uid } };
      box.add(m);
    }
    const others = m.labelIds.filter(l => !["UNREAD", "STARRED", place.label].includes(l));
    box.relabel(m, [...others, ...labels], m.labelIds.filter(l => !others.includes(l) && !labels.includes(l)));
    const f = m.fields;
    if (e.subject !== undefined) f.subject ??= e.subject;
    if (e.from?.addr) { f.sender ??= e.from.addr; if (e.from.name) f.addressDisplayNames ??= [{ displayName: e.from.name, emailAddress: e.from.addr }]; }
    if (e.to?.addr) f.toRecipients ??= [e.to.addr];
    f.date ??= new Date(Number(m.internalDate)).toISOString().replace(".000Z", "Z");
  }
}

function read(box, folder, uid, text) {
  if (typeof text !== "string") return;
  const split = text.indexOf("\n\n");
  if (split < 0) return;
  const head = text.slice(0, split).split("\n").map(line => { const at = line.indexOf(": "); return [line.slice(0, at).toLowerCase(), line.slice(at + 2)]; });
  const get = name => head.find(([n]) => n === name)?.[1];
  let body = text.slice(split + 2);
  if (/^<#(multi)?part/m.test(body)) return;
  body = body.replace(/\n+$/, "\n");
  const from = addresses(get("from") ?? "")[0];
  const date = get("date");
  const ms = dateMs(date) ?? (date ? Date.parse(date) : undefined);
  let m = byUid(box, folder, uid);
  if (!m) {
    if (!folderLabel(box, folder).known) return;
    const id = box.newId(ms ?? box.nowMs ?? 0);
    m = { id, threadId: id, labelIds: [], internalDate: String(ms ?? box.nowMs ?? 0), fields: {}, know: new Set(), observedAt: -1, uids: { [folder]: uid } };
    box.add(m);
    const place = folderLabel(box, folder).label;
    if (place) box.relabel(m, [place], []);
  }
  const inReplyTo = get("in-reply-to"), references = get("references"), messageId = get("message-id") ?? `<${m.id}@mail.gmail.com>`;
  const parent = inReplyTo && [...box.messages.values()].find(o => o !== m && o.raw && box.messageIdOf(o) === inReplyTo);
  if (parent) m.threadId = parent.threadId;
  const to = addresses(get("to") ?? ""), cc = addresses(get("cc") ?? "");
  const f = m.fields;
  if (from) { f.sender = from.email; if (from.name) f.addressDisplayNames = [{ displayName: from.name, emailAddress: from.email }]; }
  if (to.length) f.toRecipients = to.map(a => a.email);
  if (cc.length) f.ccRecipients = cc.map(a => a.email);
  if (get("subject") !== undefined) f.subject = decodeWords(get("subject"));
  f.plaintextBody = body;
  f.snippet = snippetOf(body);
  m.raw = buildMessage({ from: from ?? { name: "", email: "" }, to, cc, subject: f.subject ?? "", text: body, html: "", date: date ?? new Date(Number(m.internalDate)).toUTCString(), messageId, inReplyTo, references, boundary: `000000000000${m.id}` });
  m.rawWritten = true;
  for (const k of ["metadata", "minimal", "body"]) m.know.add(k);
}

export function learnHimalaya(box, observations) {
  for (const { argv, stdout } of observations) {
    const { words, folder, json } = command(argv);
    if (!json) continue;
    let value;
    try { value = JSON.parse(stdout); } catch { continue; }
    if (words[0] === "envelope" && words[1] === "list") envelopes(box, folder, value);
    if (words[0] === "message" && words[1] === "read" && words.length === 3 && /^\d+$/.test(words[2])) read(box, folder, Number(words[2]), value);
  }
}
