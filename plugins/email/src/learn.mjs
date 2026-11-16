// Learns mail from himalaya's JSON output: what the session's own himalaya calls printed and what a
// command-line capture read. Envelopes keep their real ids (UIDs per folder), folder and flags; a
// message whose body was read gets that body. A body never read stays unknown, so reading it falls
// through. Plain-text output is not parsed.
import { addresses, buildMessage, decodeWords, header, rfc2822, splitHead } from "./mime.mjs";
import { snippetOf } from "./mailbox.mjs";

const SYSTEM = { INBOX: "INBOX", "[Gmail]/Drafts": "DRAFT", "[Gmail]/Important": "IMPORTANT", "[Gmail]/Sent Mail": "SENT", "[Gmail]/Spam": "SPAM", "[Gmail]/Starred": "STARRED", "[Gmail]/Trash": "TRASH", "[Gmail]/All Mail": null };
export const VALUED = new Set(["-f", "--folder", "-o", "--output", "-a", "--account", "-c", "--config", "-H", "--header", "--page", "-s", "--page-size", "-w", "--max-width"]);
export const valued = (argv, option) => VALUED.has(option) || (option === "-p" && argv.includes("envelope"));

const CONDITIONS = new Set(["date", "before", "after", "from", "to", "subject", "body", "flag"]);

function command(argv, aliases = {}) {
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
  const folder = value("-f", "--folder") ?? "INBOX";
  let sorted = false;
  for (let i = 2; i < words.length && !sorted; i += CONDITIONS.has(words[i]) ? 2 : 1) sorted = words[i] === "order" && words[i + 1] === "by";
  return { words, folder: aliases[folder.toLowerCase()] ?? folder, json: value("-o", "--output") === "json", newestFirst: !sorted };
}

function folderLabel(box, folder) {
  const name = folder.toUpperCase() === "INBOX" ? "INBOX" : folder;
  if (name in SYSTEM) return { known: true, label: SYSTEM[name] };
  const user = (box.labels ?? []).find(l => l.labelType === "USER" && l.name === name);
  return user ? { known: true, label: user.labelId } : { known: false };
}

// Whether a himalaya call is a read, by the plugin's read_only entries: their words lead the command
// and their options are present.
export function reads(argv, entries) {
  const { words } = command(argv);
  return entries.some(entry => {
    const tokens = entry.split(" ").slice(1);
    return tokens.filter(t => !t.startsWith("-")).every((t, i) => words[i] === t) && tokens.filter(t => t.startsWith("-")).every(t => argv.includes(t));
  });
}

// A UID the real service printed. The copy gives its own UIDs to mail it made, such as a replayed send,
// and a later real listing replaces them.
function realUid(box, m, folder, uid) {
  for (const o of box.messages.values()) if (o !== m && o.uids[folder] === uid) { delete o.uids[folder]; o.realUids?.delete(folder); }
  m.uids[folder] = uid;
  (m.realUids ??= new Set()).add(folder);
  const info = box.folderInfo?.[folder];
  box.folderInfo = { ...box.folderInfo, [folder]: { uidvalidity: info?.uidvalidity ?? 1, uidnext: Math.max(info?.uidnext ?? 1, uid + 1) } };
}

// The minutes a listed date can show for a message: its own Date header's, or when it arrived.
const minutes = m => new Set([Number(m.internalDate), m.raw ? Date.parse(header(splitHead(m.raw).headers, "date") ?? "") : NaN].filter(Number.isFinite).map(ms => Math.floor(ms / 60000)));
const heads = m => {
  const headers = m.raw ? splitHead(m.raw).headers : [];
  return { sender: m.fields.sender ?? addresses(header(headers, "from") ?? "")[0]?.email, to: m.fields.toRecipients ?? addresses(header(headers, "to") ?? "").map(a => a.email) };
};
const byUid = (box, folder, uid) => [...box.messages.values()].find(m => m.uids[folder] === uid);
const byRealUid = (box, folder, uid) => [...box.messages.values()].find(m => m.uids[folder] === uid && m.realUids?.has(folder));
const dateMs = text => { const ms = Date.parse(String(text ?? "").replace(" ", "T")); return Number.isFinite(ms) ? ms : undefined; };
const offsetOf = text => { const found = /([+-]\d{2}):?(\d{2})$/.exec(String(text ?? "")); return found ? found[1] + found[2] : undefined; };

// himalaya prints dates to the minute, newest first. Messages listed in the same minute get seconds
// that keep the order himalaya printed them in; a listing that shows more of that minute refines them.
function envelopes(box, folder, list, newestFirst) {
  const place = folderLabel(box, folder);
  if (!place.known || !Array.isArray(list)) return;
  for (const [i, e] of list.entries()) {
    const uid = Number(e?.id);
    if (!Number.isInteger(uid)) continue;
    if (place.label === "SENT" && e.from?.addr && !box.account.email) Object.assign(box.account, { email: e.from.addr, name: box.account.name || (e.from.name ?? "") });
    const flags = new Set(e.flags ?? []);
    const labels = [...(place.label ? [place.label] : []), ...(flags.has("Seen") ? [] : ["UNREAD"]), ...(flags.has("Flagged") ? ["STARRED"] : [])];
    const minute = newestFirst && dateMs(e.date) !== undefined ? list.filter(o => o?.date === e.date).length : 0;
    const later = minute ? list.slice(i + 1).filter(o => o?.date === e.date).length : 0;
    const ms = dateMs(e.date) === undefined ? box.nowMs ?? 0 : dateMs(e.date) + Math.min(later, 59) * 1000;
    // Recorded observations of one message in different folders are joined by their envelope. A record
    // a replayed write made is never joined this way: only a recorded id ties it to anything.
    const alike = [...box.messages.values()].filter(o => {
      if (o.provisional || o.realUids?.has(folder) || o.fields.subject !== e.subject || !minutes(o).has(Math.floor(ms / 60000))) return false;
      const { sender, to } = heads(o);
      return sender === e.from?.addr && (!e.to?.addr || to.includes(e.to.addr));
    });
    let m = byRealUid(box, folder, uid) ?? (alike.length === 1 ? alike[0] : undefined);
    if (!m && alike.length > 1) continue;
    if (m) {
      realUid(box, m, folder, uid);
      if (m.minute !== undefined && minute >= m.minute && Math.floor(Number(m.internalDate) / 60000) === Math.floor(ms / 60000)) Object.assign(m, { internalDate: String(ms), minute });
    } else {
      const id = box.newId(ms);
      m = { id, threadId: id, labelIds: [], internalDate: String(ms), fields: {}, know: new Set(["metadata"]), observedAt: -1, uids: {}, minute };
      box.add(m);
      realUid(box, m, folder, uid);
    }
    const others = m.labelIds.filter(l => !["UNREAD", "STARRED", place.label].includes(l));
    box.relabel(m, [...others, ...labels], m.labelIds.filter(l => !others.includes(l) && !labels.includes(l)));
    m.dateOffset ??= offsetOf(e.date);
    const f = m.fields;
    if (e.subject !== undefined) f.subject ??= e.subject;
    if (e.from?.addr) { f.sender ??= e.from.addr; if (e.from.name) f.addressDisplayNames ??= [{ displayName: e.from.name, emailAddress: e.from.addr }]; }
    if (e.to?.addr) { f.toRecipients ??= [e.to.addr]; if (e.to.name) m.names = { ...m.names, [e.to.addr]: e.to.name }; }
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
  const stableId = get("message-id");
  let m = byRealUid(box, folder, uid) ?? (stableId ? [...box.messages.values()].find(o => o.raw && header(splitHead(o.raw).headers, "message-id") === stableId) : undefined);
  if (m && !m.realUids?.has(folder)) realUid(box, m, folder, uid);
  if (!m) {
    if (!folderLabel(box, folder).known) return;
    const id = box.newId(ms ?? box.nowMs ?? 0);
    m = { id, threadId: id, labelIds: [], internalDate: String(ms ?? box.nowMs ?? 0), fields: {}, know: new Set(), observedAt: -1, uids: {} };
    box.add(m);
    realUid(box, m, folder, uid);
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
  m.raw = buildMessage({ from: from ?? { name: "", email: "" }, to, cc, subject: f.subject ?? "", text: body, html: "", date: date ?? rfc2822(new Date(Number(m.internalDate)), "UTC", m.dateOffset), messageId, inReplyTo, references, boundary: `000000000000${m.id}` });
  m.rawWritten = true;
  for (const k of ["metadata", "minimal", "body"]) m.know.add(k);
}

// A recorded `envelope list -o json` run against the copy: when the copy listed the same messages,
// they take the ids the real list printed, so later calls by those ids reach them.
export function takeUids(box, argv, ours, theirs, aliases = {}) {
  const { words, folder, json } = command(argv, aliases);
  if (!json || words[0] !== "envelope" || words[1] !== "list") return;
  let copy, real;
  try { copy = JSON.parse(ours); real = JSON.parse(theirs); } catch { return; }
  if (!Array.isArray(copy) || !Array.isArray(real) || copy.length !== real.length) return;
  const identity = e => JSON.stringify([e?.subject, e?.from?.addr, e?.from?.name, e?.to?.addr, e?.date, e?.has_attachment]);
  if (new Set(copy.map(identity)).size !== copy.length) return;
  const pairs = copy.map((e, i) => [byUid(box, folder, Number(e?.id)), Number(real[i]?.id), identity(e) === identity(real[i])]);
  if (pairs.some(([m, uid, same]) => !m || m.provisional || !Number.isInteger(uid) || !same)) return;
  const moving = new Set(pairs.map(([m]) => m));
  if (pairs.some(([, uid]) => { const holder = byUid(box, folder, uid); return holder && !moving.has(holder); })) return;
  for (const [m, uid] of pairs) realUid(box, m, folder, uid);
}

// What a recorded JSON envelope list shows: its folder and account, how many entries it printed, its
// page size when the call gave one, and whether it is the first page with no search.
export function listShape(argv, stdout, aliases = {}) {
  const { words, folder, json } = command(argv, aliases);
  if (!json || words[0] !== "envelope" || words[1] !== "list") return;
  const option = names => { for (let i = argv.length - 1; i > 0; i--) { if (names.includes(argv[i])) return argv[i + 1]; const eq = names.map(n => argv[i].startsWith(n + "=") && argv[i].slice(n.length + 1)).find(Boolean); if (eq) return eq; } };
  let list;
  try { list = JSON.parse(stdout); } catch { return; }
  if (!Array.isArray(list)) return;
  const size = option(["--page-size", "-s"]);
  return { folder, account: option(["--account", "-a"]) ?? "", count: list.length, size: size === undefined ? undefined : Number(size), first: Number(option(["--page", "-p"]) ?? 1) === 1 && words.length === 2 };
}

// The folders a himalaya write puts mail into or takes it out of, by name; undefined when the copy can't tell.
// All Mail, Starred and Important follow from the others.
export function touches(box, argv, stdin, aliases = {}) {
  const { words, folder } = command(argv, aliases);
  const name = word => aliases[String(word ?? "").toLowerCase()] ?? word;
  const sent = aliases.sent ?? "[Gmail]/Sent Mail", trash = aliases.trash ?? "[Gmail]/Trash";
  const [noun, verb, target] = words;
  if ((noun === "message" || noun === "template") && ["send", "reply", "forward"].includes(verb)) {
    const { headers } = splitHead(Buffer.from(String(stdin ?? "")));
    const to = ["to", "cc", "bcc"].flatMap(h => addresses(header(headers, h) ?? "").map(x => x.email.toLowerCase()));
    const me = box.account.email?.toLowerCase();
    return verb === "send" && me && !to.includes(me) ? [sent] : [sent, "INBOX"];
  }
  if ((noun === "message" || noun === "template") && verb === "save") return [folder];
  if (noun === "message" && verb === "move" && target) return [folder, name(target)];
  if (noun === "message" && verb === "copy" && target) return [name(target)];
  if (noun === "message" && verb === "delete") return folder === trash ? [folder] : [folder, trash];
  if (noun === "flag" && ["add", "set", "remove"].includes(verb)) return [folder];
  if (noun === "folder" && ["expunge", "purge", "delete", "add", "create"].includes(verb) && target) return [name(target)];
}

// The label a folder name stands for (null for All Mail), or undefined for a folder the copy doesn't know.
export function labelOf(box, folder) {
  const place = folderLabel(box, folder);
  return place.known ? place.label : undefined;
}
export function learnHimalaya(box, observations, aliases = {}) {
  for (const { argv, stdout } of observations) {
    const { words, folder, json, newestFirst } = command(argv, aliases);
    if (!json) continue;
    let value;
    try { value = JSON.parse(stdout); } catch { continue; }
    if (words[0] === "envelope" && words[1] === "list") envelopes(box, folder, value, newestFirst);
    if (words[0] === "message" && words[1] === "read" && words.length === 3 && /^\d+$/.test(words[2])) read(box, folder, Number(words[2]), value);
  }
}
