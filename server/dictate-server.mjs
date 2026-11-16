#!/usr/bin/env node
// watch-dictate receiver. The watch POSTs a recorded clip; this transcribes it locally
// (Parakeet), applies the word lists, and posts the text as a user message into the chat the
// clip names: a Happy session id or a T3 thread. A note only ever goes to the chat it names; if
// that can't take it, it is held, never sent elsewhere. Reached through the Cloudflare tunnel;
// bearer-token auth.
//
//   GET  /health     liveness + connection pre-warm (no auth)
//   POST /dictate    body = audio (AAC/m4a), headers X-Clip-Id, X-Duration-Ms
//   POST /timing     JSON { clipId, releaseToAckMs, ... } measured on the watch
//   GET  /history    the chat's last messages for the watch (long-polls with ?v=&wait=)
//   POST /netlog     JSON { failures: [...] }: the watch's failed requests since the last one that worked

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRecognizer, decodeToPcm, transcribe } from './lib/transcribe.mjs';
import { applyDictionary } from './lib/replace.mjs';
import { Happy } from './lib/happy.mjs';
import { deepgramTranscribe, keyterms } from './lib/deepgram.mjs';
import { openStore } from './lib/store.mjs';
import { waitForReply, turnOpen } from './lib/replies.mjs';
import { GONE, cappedExtras, chatTitle as title, isArchived, mainEntry, readListing, refusalFor, selectedEntry, watchList } from './lib/chats.mjs';
import { historyItems, HistoryCache } from './lib/history.mjs';
import { messageFor, shouldSteer, MID_TURN } from './lib/message.mjs';
import { T3, waitForT3Reply, t3HistoryItems, isRoomAudio, isT3Wire, parseT3Target, t3Flag, t3ThreadRows } from './lib/t3.mjs';
import { speakable, synthesize, voiceSetting, setVoiceSetting, voiceModeSessions } from './lib/speech.mjs';
import { AcceptedNotes, readHeldNotes, writeAtomic } from './lib/accepted.mjs';
import { describeFailure, serverAbortRow, watchFailureRow } from './lib/netlog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.WATCH_DICTATE_PORT || 8790);
const DATA = env.WATCH_DICTATE_DATA || path.join(os.homedir(), '.local/share/watch-dictate');
const MODEL = env.WATCH_DICTATE_MODEL || path.join(DATA, 'models/parakeet-tdt-0.6b-v2-int8');
const TOKEN_FILE = env.WATCH_DICTATE_TOKEN_FILE || path.join(os.homedir(), '.config/watch-dictate/token');
const TEST_LEGACY_CHAT = env.WATCH_DICTATE_TARGET_SESSION || '';   // tests: what an old build's target means, instead of Happy's setting
const KEEP_CLIPS = Number(env.WATCH_DICTATE_KEEP_CLIPS ?? 200);
const CLIPS = path.join(DATA, 'clips');
const TTS_DIR = path.join(DATA, 'tts');
const NOTIFY = env.WATCH_DICTATE_NOTIFY || path.join(os.homedir(), '.local/bin/happy-notify');
const LOG = path.join(DATA, 'dictations.jsonl');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const MAX_BODY = 90 * 1024 * 1024;   // ~8 h of watch audio (about 24.5 kbps AAC, measured: 8 h is 88 MB); Cloudflare's cap is 100 MB

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const append = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + '\n', { mode: 0o600 });
// A promise nobody caught would end the process (Node's default), taking every note in progress
// with it. Log it and keep running.
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));

fs.mkdirSync(CLIPS, { recursive: true });
const store = openStore(path.join(DATA, 'dictations.db'));

// Shared settings the phone and watch both read and change (one source of truth).
// extras: the Happy chats on the watch's list, all alike.
// replyWatch: show the chat's answer to each note on the watch; replyPush: also send it as a
// push (it reaches the wrist when the phone is locked).
const DEFAULTS = { engine: 'deepgram', autoStart: true, extras: [], continuous: false, tag: 'detailed', replyWatch: true, replyPush: true, speak: 'phone', midTurn: 'steer' };
// midTurn: a note sent while the chat is running a turn steers it or waits for the next turn
// (see shouldSteer). Continuous notes always wait. T3 threads have no steer and always wait.
// speak: read replies aloud. 'phone' plays on the iPhone (so it reaches the car over
// Bluetooth), 'watch' on the watch speaker, 'off'.
const SPEAK = ['off', 'phone', 'watch'];
// voice ('elevenlabs' | 'deepgram'): not stored here; it's the account's read-aloud voice on
// the relay, shared with the Claudeputer app.
const VOICES = ['deepgram', 'elevenlabs'];
const TAGS = ['off', 'simple', 'detailed'];
const readSettings = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; } };

// T3 Code threads as more places notes can go: settings.json's t3 turns this on, by hand. Without it
// there is no T3 option and the server never calls T3. Target id on the wire: 't3:<thread id>'.
// t3.threadId and legacyMain only give meaning to the 't3' and 'main' targets of builds before 1.0.42.
const T3_TARGET = 't3';
const t3Config = () => {
  const c = readSettings().t3;
  if (!c) return null;
  return { threadId: typeof c.threadId === 'string' ? c.threadId : null, title: String(c.title || 'T3').slice(0, 60) };
};
const t3Titles = new Map();   // threadId -> its title in T3, from the last read
let t3Client = null;
function t3() {
  if (!t3Client) {
    t3Client = new T3({ log });
    process.once('SIGTERM', () => { Promise.race([t3Client.close(), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(0)); });
  }
  return t3Client;
}
const heldError = (message, extra = {}) => Object.assign(new Error(message), { status: 409, ...extra });
/** The T3 thread a target means. A note goes to exactly this thread, or it's held. */
function t3Target(wanted) {
  const c = t3Config();
  if (!c) throw heldError('T3 is off. Pick another chat');
  const threadId = parseT3Target(wanted, c.threadId);
  if (!threadId) throw heldError('Pick a chat for this note');
  return { threadId, title: t3Titles.get(threadId) || 'T3 thread' };
}
const T3_FAILED = 'T3 send failed. Note saved, will retry';   // what the watch shows

/** The T3 screen's threads, shared for a few seconds. T3 down: none, marked stale. */
let t3List = null;
function t3Threads() {
  if (t3List && Date.now() - t3List.at < 5000) return t3List.p;
  const p = (async () => {
    try {
      const { threads, projects } = await t3().listThreads();
      for (const t of threads) t3Titles.set(t.threadId, t.title);
      return { threads, projects, stale: false };
    } catch (err) {
      log(`t3 threads: ${err.message}`);
      t3List = null;
      return { threads: [], projects: new Map(), stale: true };
    }
  })();
  t3List = { at: Date.now(), p };
  return p;
}
/** One thread's details, read directly: it can be off the list (settled, snoozed). */
async function t3Thread(threadId) {
  const { thread } = await t3().call('t3_thread_read', { threadId, limit: 1, runLimit: 1 });
  t3Titles.set(threadId, thread.title);
  return thread;
}
/** Waits briefly for a thread's real name when it isn't known yet (first use after a restart). */
async function t3TargetNamed(wanted) {
  const target = t3Target(wanted);
  if (t3Titles.has(target.threadId)) return target;
  await Promise.race([t3Thread(target.threadId).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  return t3Target(wanted);
}

// Builds before 1.0.42 and their queued clips say 'main'. That now means one fixed chat: what Happy's
// main chat was at the first start of this version. It's frozen and also goes on the watch's list, so
// nothing changes under the user on update, and Happy's setting never decides where a note goes again.
let migrating = null;
function migrateLegacyMain() {
  migrating ??= (async () => {
    if (readSettings().legacyMain) return;
    const id = TEST_LEGACY_CHAT || (await happy.settings()).mainChatSessionId;
    if (!id) return;
    const next = readSettings();
    next.legacyMain = id;
    next.extras = [id, ...next.extras.filter((x) => x !== id)];
    writeSettings(next);
    log(`old 'main' target now means chat ${id}`);
  })().catch((err) => log(`old 'main' target not resolved yet: ${err.message}`)).finally(() => { migrating = null; });
  return migrating;
}
async function legacyMainId() {
  if (!readSettings().legacyMain) await migrateLegacyMain();
  return readSettings().legacyMain || null;
}

/** The Happy chat a target names. Gone or unknown: held for the user to pick, never another chat. */
async function happyTarget(wanted) {
  const id = wanted === 'main' ? await legacyMainId() : wanted;
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw heldError('Pick a chat for this note');
  try {
    const session = await happy.session(id);
    return { id, session, title: title(session.metadata), kind: 'extra' };
  } catch (err) {
    if (/not found/.test(err.message)) throw heldError(GONE);
    throw err;
  }
}

// "Dictating on watch" bars in Happy. Per chat: the recording in progress (kept alive
// by the watch's 15 s heartbeat) and the clips still being transcribed. The chat shows
// recording if one is live, else transcribing if any clip is pending, else nothing.
// Continuous mode overlaps the two: the next note records while the last one uploads.
const RECORDING_TTL_MS = 40_000;
const PENDING_TTL_MS = 180_000;
const REPLY_WAIT_MS = Number(env.WATCH_DICTATE_REPLY_WAIT_MS || 60_000);
const live = new Map();            // sessionId -> { rec: { clipId, startedAt, at } | null, pending: Map(clipId -> startedAt) }
const recordingChat = new Map();   // clipId -> sessionId it was announced in
const chatState = (sid) => { if (!live.has(sid)) live.set(sid, { rec: null, pending: new Map() }); return live.get(sid); };

function emitDictation(sid) {
  const c = chatState(sid);
  if (c.rec && Date.now() - c.rec.at > RECORDING_TTL_MS) c.rec = null;
  const firstPending = c.pending.values().next().value;
  const status = c.rec ? { state: 'recording', startedAt: c.rec.startedAt }
    : c.pending.size ? { state: 'transcribing', startedAt: firstPending }
    : { state: 'idle' };
  if (!c.rec && !c.pending.size) live.delete(sid);
  happy.socket?.emit('dictation-status', { sid, ...status });
}

const statusChat = async (target) => (target === 'main' ? legacyMainId() : target);

/** A watch status ping: recording (start or heartbeat), transcribing (tapped send), idle (cancel). */
async function dictationStatus({ state, clipId, target, startedAt }) {
  if (isT3Wire(target)) {   // the bar is a Happy feature; T3 shows none. Clear it if the crown just left a chat.
    const prev = recordingChat.get(clipId);
    if (prev) {
      const c = chatState(prev); if (c.rec?.clipId === clipId) c.rec = null;
      recordingChat.delete(clipId);
      emitDictation(prev);
    }
    return;
  }
  const sid = await statusChat(target);
  if (!sid || !clipId) return;
  const prev = recordingChat.get(clipId);
  if (prev && prev !== sid) {   // the crown moved this recording to another chat
    const c = chatState(prev); if (c.rec?.clipId === clipId) c.rec = null;
    emitDictation(prev);
  }
  const c = chatState(sid);
  if (state === 'recording') {
    c.rec = { clipId, startedAt: Number(startedAt) || Date.now(), at: Date.now() };
    recordingChat.set(clipId, sid);
  } else {
    if (c.rec?.clipId === clipId) c.rec = null;
    recordingChat.delete(clipId);
    // The upload can beat this ping; a clip that already landed needs no bar.
    if (state === 'transcribing' && !finishedClips.has(clipId)) {
      c.pending.set(clipId, Number(startedAt) || Date.now());
      // Still uploading or transcribing (long notes take minutes): keep the bar up.
      const expire = () => inflight.has(clipId) ? setTimeout(expire, PENDING_TTL_MS).unref() : clipDone(sid, clipId);
      setTimeout(expire, PENDING_TTL_MS).unref();
    } else c.pending.delete(clipId);
  }
  emitDictation(sid);
}

const finishedClips = new Set();
function clipFinished(clipId) {
  finishedClips.add(clipId);
  setTimeout(() => finishedClips.delete(clipId), 10 * 60_000).unref();
  for (const sid of [...live.keys()]) clipDone(sid, clipId);
}

// The app hides "Transcribing" after 3 minutes without news; repeat it while work goes on.
setInterval(() => { for (const [sid, c] of live) if (c.pending.size) emitDictation(sid); }, 60_000).unref();

function clipDone(sid, clipId) {
  if (!live.get(sid)?.pending.delete(clipId)) return;
  emitDictation(sid);
}

const chatTitles = new Map();
const archivedChats = new Set();   // so a failed read doesn't bring one back onto the list
/** The Happy chats on the watch's list. A chat that was really deleted comes off it for good. */
async function watchChats(listing) {
  const list = await watchList(happy, readSettings().extras, listing, chatTitles, archivedChats);
  if (list.deleted.length) {
    const next = readSettings();
    next.extras = next.extras.filter((id) => !list.deleted.includes(id));
    writeSettings(next);
    log(`off the watch's list, deleted: ${list.deleted.join(', ')}`);
  }
  return list.destinations;
}

/** A chat a new note can go to: an archived or deleted one is held, like any other chat that's gone. */
async function noteTarget(wanted, listing = readListing(happy, log)) {
  const target = await happyTarget(wanted);
  const refusal = await refusalFor(happy, target.id, await listing);
  if (refusal) throw heldError(refusal);
  return target;
}

/** The list builds before 1.0.42 expect, so they keep working until updated: their 'main' row is
 *  the frozen chat, and 't3' the thread they knew. New builds read `destinations` instead. */
async function oldBuildChats(chats) {
  const mainId = await legacyMainId().catch(() => null);
  const main = chats.find((c) => c.id === mainId);
  const out = [{ id: 'main', title: main?.title ?? 'Chat', isMain: true }, ...chats.filter((c) => c.id !== mainId).map((c) => ({ ...c, isMain: false }))];
  const c = t3Config();
  if (c?.threadId) out.push({ id: T3_TARGET, title: (await t3TargetNamed(T3_TARGET).catch(() => null))?.title ?? c.title, isMain: false });
  return out;
}

/** What an old build's stored target or queued clips now mean, so they can move to the real id. */
async function legacyTargets(chats) {
  const out = {};
  const mainId = await legacyMainId().catch(() => null);
  if (mainId) out.main = { id: mainId, title: chats.find((c) => c.id === mainId)?.title ?? 'Chat' };
  const c = t3Config();
  if (c?.threadId) out.t3 = { id: `t3:${c.threadId}`, title: (await t3TargetNamed(T3_TARGET).catch(() => null))?.title ?? c.title };
  return out;
}
const writeSettings = (next) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
const TOKEN = Buffer.from(fs.readFileSync(TOKEN_FILE, 'utf8').trim());
if (!TOKEN.length) throw new Error(`${TOKEN_FILE} is empty: refusing to start with no token`);
const recognizer = await loadRecognizer(MODEL, Number(env.WATCH_DICTATE_THREADS || 6));
const RELAY = env.HAPPY_LOCAL_URL || 'http://localhost:3005';
const happy = new Happy({
  server: RELAY,
  pushServer: env.HAPPY_SERVER_URL || '',
});
happy.listen(log);
const history = new HistoryCache(happy);
migrateLegacyMain();
let lastHappySettings = {};   // only T3 notes use this, when the relay is down


// One decode at a time: dictations rarely overlap, and parallel decodes just split the CPU.
let sttQueue = Promise.resolve();
const serial = (fn) => { const run = sttQueue.then(fn, fn); sttQueue = run.catch(() => {}); return run; };

// The first decode after a long idle ran ~4x slower (model pages cold). Decode a second
// of silence every few minutes so a real note never pays that.
const warm = () => serial(() => transcribe(recognizer, new Float32Array(16000))).catch(() => {});
warm();
setInterval(warm, 4 * 60 * 1000);

// Retries reuse the same clip id; answer them from here instead of re-sending.
const results = new Map();
const inflight = new Map();
const remember = (id, r) => { results.set(id, r); if (results.size > 500) results.delete(results.keys().next().value); };

function pruneClips() {
  const files = fs.readdirSync(CLIPS).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_CLIPS))) fs.rmSync(path.join(CLIPS, f), { force: true });
}

/** Deepgram when asked for, falling back to local Parakeet if it fails or is slow. */
async function transcribeClip(engine, audio, samples, dictionary) {
  if (engine === 'deepgram') {
    try {
      // ~4 s for 30 min in testing; allow 6 s plus a little per minute of audio.
      const timeoutMs = Math.round(6000 + (samples.length / 16000 / 60) * 400);
      return { raw: await deepgramTranscribe(audio, { terms: keyterms(dictionary), timeoutMs }), engine: 'deepgram' };
    } catch (err) {
      log(`deepgram failed, using local: ${err.message}`);
      const raw = await transcribe(recognizer, samples, serial);
      return { raw, engine: 'local', error: `deepgram: ${err.message}` };
    }
  }
  return { raw: await transcribe(recognizer, samples, serial), engine: 'local' };
}

async function processClip(clipId, audio, meta) {
  const t0 = performance.now();
  const receivedAt = new Date().toISOString();
  const before = store.get(clipId);
  // A retry after a restart, when the first try already reached T3 (T3 can't dedupe a CLI send).
  // Compare the thread: a held note the user sent somewhere else is a new send.
  if (before?.status === 'sent' && before.target_kind === T3_TARGET && isT3Wire(meta.target) && t3Config() && parseT3Target(meta.target, t3Config().threadId) === before.session_id) {
    return { ok: true, text: before.corrected, chat: before.chat, engine: before.engine, replay: true };
  }
  store.start(clipId, { received_at: receivedAt });
  store.update(clipId, { ended_by: meta.endedBy, paused_ms: meta.pausedMs });
  if (!isT3Wire(meta.target)) {
    if (meta.auto) store.update(clipId, { auto: '1' });   // for if the user sends this held clip to a T3 thread
  } else {
    // Room audio must keep its handling note on every retry (see isRoomAudio).
    const auto = isRoomAudio({ header: meta.autoHeader, hasDuration: meta.recordMs != null, remembered: before?.auto });
    store.update(clipId, { auto: auto ? '1' : '0' });
    meta = { ...meta, auto };
  }
  try {
    return await runClip(clipId, audio, meta, t0, receivedAt);
  } catch (err) {
    store.update(clipId, { status: 'error', error: err.detail ?? err.message, server_ms: Math.round(performance.now() - t0) });
    throw err;
  } finally {
    clipFinished(clipId);
  }
}

async function runClip(clipId, audio, meta, t0, receivedAt) {
  const stamp = receivedAt.replace(/[:.]/g, '-');
  const file = path.join(CLIPS, `${stamp}-${clipId}.m4a`);
  fs.writeFileSync(file, audio, { mode: 0o600 });
  const settingsP = happy.settings();
  settingsP.catch(() => {});
  // Read alongside the transcription, so checking the chat adds no wait to the note.
  const listingP = isT3Wire(meta.target) ? null : readListing(happy, log);

  const samples = await decodeToPcm(file);
  const t1 = performance.now();
  const recordedSec = +(samples.length / 16000).toFixed(2);
  store.update(clipId, { recorded_sec: recordedSec });
  // The dictionary (Happy's, the one source of truth) also feeds Deepgram's keyterms.
  // T3 doesn't depend on the relay, so a relay outage only costs it fresh dictionary words.
  const settings = isT3Wire(meta.target) ? await settingsP.catch(() => lastHappySettings) : await settingsP;
  lastHappySettings = settings;
  const dictionary = settings.dictationDictionary ?? [];
  const { raw, engine, error } = await transcribeClip(meta.engine, audio, samples, dictionary);
  const t2 = performance.now();
  const entry = {
    type: 'dictation', clipId, at: receivedAt, audioBytes: audio.length, audioSec: recordedSec,
    recordMs: meta.recordMs, endedBy: meta.endedBy, pausedMs: meta.pausedMs, raw, engine, decodeMs: Math.round(t1 - t0), sttMs: Math.round(t2 - t1),
  };
  if (KEEP_CLIPS === 0) fs.rmSync(file, { force: true }); else pruneClips();
  store.update(clipId, { engine, raw, stt_ms: entry.sttMs, error: error ?? null });

  if (!raw) {
    const serverMs = Math.round(performance.now() - t0);
    append({ ...entry, empty: true, serverMs });
    store.update(clipId, { status: 'empty', server_ms: serverMs });
    return { ok: true, empty: true, text: '' };
  }
  const text = applyDictionary(raw, dictionary);
  store.update(clipId, { corrected: text });
  if (isT3Wire(meta.target)) return sendToT3(clipId, text, meta, { entry, error, engine, recordedSec, t0 });
  // A note already accepted has left the watch, so if this fails the server has to keep it.
  const keep = (err, sent = messageFor(text, { sec: recordedSec, auto: meta.auto }, readSettings().tag)) =>
    Object.assign(err, { heldNote: { clipId, target: meta.target, chat: store.get(clipId)?.chat ?? 'your chat', text: sent.text, displayText: sent.displayText, localId: `watch-${clipId}` } });
  let target;
  try { target = await noteTarget(meta.target, listingP); } catch (err) { throw keep(err); }
  const { id: sessionId, session, title: chat } = target;
  store.update(clipId, { target_kind: target.kind });
  store.update(clipId, { corrected: text, chat, session_id: sessionId });
  const localId = `watch-${clipId}`;
  const pushed = happy.waitForPush(localId);
  const t4 = performance.now();
  // In /voice mode the Claudeputer app reads the reply aloud, as for notes typed on the phone.
  const voice = (await voiceModeSessions(RELAY, happy.credentials.token)).includes(sessionId);
  const message = messageFor(text, { sec: recordedSec, auto: meta.auto }, readSettings().tag, { voice });
  const { midTurn, continuous: continuousOn } = readSettings();
  // Every first send carries its length; a retry from the watch's outbox doesn't.
  let steer = shouldSteer({ midTurn, auto: meta.auto, continuousOn, retry: meta.recordMs == null, flavor: session.metadata?.flavor, text: message.text });
  // Codex tells the chat "the steer arrived late" when no turn is running, so an idle Codex chat
  // must not get the flag. Claude treats it as an ordinary message and needs no check.
  if (steer && session.metadata?.flavor === 'codex') steer = await turnRunning(session);
  store.update(clipId, { steer: steer ? '1' : '0' });
  let posted;
  try { posted = await happy.send(session, message.text, localId, { displayText: message.displayText, steer }); }
  catch (err) { throw keep(/HTTP 40[34]/.test(err.message) ? heldError(GONE) : err, message); }
  const t5 = performance.now();
  const mine = posted?.find((m) => m.localId === localId);
  if (mine) awaitReply(clipId, session, mine, chat, { voice });
  const timings = {
    decodeMs: entry.decodeMs, sttMs: entry.sttMs, postMs: Math.round(t5 - t4), serverMs: Math.round(t5 - t0),
  };
  store.update(clipId, { status: 'sent', server_ms: timings.serverMs });
  pushed.then((at) => append({
    ...entry, ...timings, text, sessionId, chat, steer,
    pushAfterPostMs: at === null ? null : Math.round(at - (performance.timeOrigin + t5)),
  })).catch((err) => log(`clip ${clipId}: timing row not written: ${err.message}`));
  return { ok: true, text, chat, engine, timings };
}

/** The same note as a Happy chat gets (tag and room-audio note), posted to the T3 thread. On
 *  failure the watch keeps the clip and shows why; see acceptedClipFailed. */
/** Is the chat running a turn? Pages back to the last turn boundary. Can't tell: no, so the note queues. */
async function turnRunning(session) {
  try {
    for (const count of [100, 500]) {
      const open = turnOpen((await happy.latestMessages(session, count)).map((m) => m.content));
      if (open !== null) return open;
    }
  } catch (err) { log(`turn check failed: ${err.message}`); }
  return false;
}

async function sendToT3(clipId, text, meta, { entry, error, engine, recordedSec, t0 }) {
  const message = messageFor(text, { sec: recordedSec, auto: meta.auto }, readSettings().tag);
  let threadId, chat;
  try { ({ threadId, title: chat } = await t3TargetNamed(meta.target)); }
  catch (err) { throw Object.assign(err, { heldNote: { clipId, target: meta.target, chat: 'T3', text: message.text } }); }
  store.update(clipId, { target_kind: T3_TARGET, corrected: text, chat, session_id: threadId });
  const t4 = performance.now();
  let sent;
  try {
    sent = await t3().send(threadId, message.text);
  } catch (err) {
    log(`clip ${clipId}: T3 send failed: ${err.message}`);
    const detail = [error, `T3: ${err.message}`].filter(Boolean).join('; ');
    const gone = /not found/i.test(err.message);
    throw Object.assign(new Error(gone ? 'That T3 thread is gone. Pick another chat' : T3_FAILED), { status: gone ? 409 : 503, detail, heldNote: { clipId, target: `t3:${threadId}`, chat, text: message.text } });
  }
  const t5 = performance.now();
  const timings = { decodeMs: entry.decodeMs, sttMs: entry.sttMs, postMs: Math.round(t5 - t4), serverMs: Math.round(t5 - t0) };
  store.update(clipId, { status: 'sent', server_ms: timings.serverMs, error: error ?? null });
  append({ ...entry, ...timings, text, sessionId: threadId, chat, target: T3_TARGET, delivery: sent.delivery });
  followT3Reply(clipId, threadId, sent.runId, chat);
  return { ok: true, text, chat, engine, timings };
}

function followT3Reply(clipId, threadId, runId, chat) {
  followReply(clipId, () => waitForT3Reply(t3(), threadId, runId), { chat, screenKey: `t3:${threadId}` });
}

// A long note gets "accepted" at 60 s, and the watch then deletes its copy. If the send fails after
// that, the server owns the note: saved here and retried, to that same chat only, until it's taken.
const HELD_NOTES = path.join(DATA, 'held-notes');
const OLD_HELD_NOTES = path.join(DATA, 't3-outbox');
if (fs.existsSync(OLD_HELD_NOTES) && !fs.existsSync(HELD_NOTES)) fs.renameSync(OLD_HELD_NOTES, HELD_NOTES);
const HELD_RETRY_MS = Number(env.WATCH_DICTATE_T3_RETRY_MS || 60_000);
function acceptedClipFailed(note) {
  fs.mkdirSync(HELD_NOTES, { recursive: true, mode: 0o700 });
  writeAtomic(path.join(HELD_NOTES, `${note.clipId}.json`), JSON.stringify(note));
  notifyReply(null, note.chat, `Your long note did not reach ${note.chat}. It is saved and will retry there.`);
}
let heldRetrying = false;
async function deliverHeld(note) {
  const wanted = note.target ?? `t3:${note.threadId}`;   // notes saved by the previous version
  if (isT3Wire(wanted)) {
    const { threadId, title: chat } = await t3TargetNamed(wanted);
    const sent = await t3().send(threadId, note.text);
    followT3Reply(note.clipId, threadId, sent.runId, chat);
    return;
  }
  const { session, title: chat } = await noteTarget(wanted);
  const posted = await happy.send(session, note.text, note.localId, { displayText: note.displayText });
  const mine = posted?.find((m) => m.localId === note.localId);
  if (mine) awaitReply(note.clipId, session, mine, chat);
}
async function retryHeldNotes() {
  if (heldRetrying) return;
  heldRetrying = true;
  try {
    try { await redoAccepted(); } catch (err) { log(`accepted notes: ${err.message}`); }   // never in the held notes' way
    for (const { file, note } of readHeldNotes(HELD_NOTES)) {
      try { await deliverHeld(note); }
      catch (err) { log(`clip ${note.clipId}: held note retry failed: ${err.message}`); continue; }   // one chat's trouble doesn't hold the others
      fs.rmSync(file, { force: true });
      store.update(note.clipId, { status: 'sent', error: null });
      log(`clip ${note.clipId}: held note delivered`);
    }
  } catch (err) { log(`held notes: ${err.message}`); } finally { heldRetrying = false; }
}
setInterval(retryHeldNotes, HELD_RETRY_MS).unref();

// Accepted notes still owed to a chat: the audio and where it was going, saved when the watch was
// told "accepted" (see lib/accepted.mjs). A note whose work failed before it had any text, or that
// was cut short by a restart, is transcribed and sent again from here, to the same chat only.
const accepted = new AcceptedNotes(path.join(DATA, 'accepted'));
/** The clip's job ended after the watch was told "accepted". */
function acceptedSettled(clipId, err) {
  if (!err) { accepted.done(clipId); return; }
  if (err.heldNote) {   // it has its text: the held notes carry it from here
    acceptedClipFailed(err.heldNote);
    accepted.done(clipId);
    return;
  }
  const first = !accepted.due(Infinity).find((r) => r.clipId === clipId)?.tries;
  if (accepted.failed(clipId)) {
    if (first) notifyReply(null, 'Dictation', 'A long note hit a problem before it was sent. It is saved and will be tried again.');
  } else {
    log(`clip ${clipId}: accepted note set aside after ${accepted.maxTries} tries; audio kept in ${accepted.dir}`);
    notifyReply(null, 'Dictation', 'A long note could not be sent after many tries. Its audio is kept on the server.');
  }
}
async function redoAccepted() {
  for (const { clipId, meta, tries } of accepted.due()) {
    if (inflight.has(clipId)) continue;   // still on its first run
    const row = store.get(clipId);
    if (row?.status === 'sent' || row?.status === 'empty' || fs.existsSync(path.join(HELD_NOTES, `${clipId}.json`))) { accepted.done(clipId); continue; }
    log(`clip ${clipId}: accepted note, trying again (try ${tries + 1})`);
    store.update(clipId, { status: 'processing' });
    // No length: a redo is a retry, so it queues behind a running turn instead of steering it.
    const job = processClip(clipId, accepted.audio(clipId), { ...meta, recordMs: null }).finally(() => inflight.delete(clipId));
    inflight.set(clipId, job);
    try {
      const r = await job;
      remember(clipId, r);
      acceptedSettled(clipId, null);
      log(`clip ${clipId}: accepted note delivered`);
    } catch (err) {
      log(`clip ${clipId}: accepted note failed again: ${err.message}`);
      acceptedSettled(clipId, err);
    }
  }
}
setTimeout(retryHeldNotes, 5000).unref();   // what a restart left behind

// Chats the watch app has open right now: it long-polls /history only while on screen. Value:
// Infinity during a poll, else when the last one ended (the next follows within a second).
const watchOnScreen = new Map();
const WATCH_ON_SCREEN_MS = 5000;

/** Waits for the chat's answer to a note, stores it for the watch, and pushes it. */
function awaitReply(clipId, session, message, chat, { voice = false } = {}) {
  followReply(clipId, () => waitForReply(happy, session, message), { chat, voice, screenKey: session.id, pushChat: session.id });
}

/** Stores the answer `wait` resolves with for the watch, reads it aloud, and pushes it. */
function followReply(clipId, wait, { chat, voice = false, screenKey, pushChat = null }) {
  const s = readSettings();
  if (!s.replyWatch && !s.replyPush && s.speak === 'off') return;
  store.update(clipId, { reply_status: 'waiting' });
  wait().then(async (r) => {
   try {
    if (!r) { store.update(clipId, { reply_status: 'none' }); log(`clip ${clipId}: no reply in time`); return; }
    // Spoken reply first, so the watch hears "done" only once there's audio to play.
    // A /voice chat is read by the Claudeputer app on the phone, so "On the iPhone" here would
    // say it twice; "On the watch" still plays it on the watch.
    const speak = readSettings().speak;
    const audioSec = speak === 'watch' || (speak === 'phone' && !voice) ? await speakReply(clipId, r.text) : null;
    store.update(clipId, { reply: r.text.slice(0, 20000), reply_audio_sec: audioSec, reply_status: 'done', reply_at: new Date().toISOString() });
    log(`clip ${clipId}: reply ${r.text.length} chars`);
    if (!readSettings().replyPush) return;
    // The watch app is open on this chat: the reply shows there, and a system notification
    // would only cover the chat's title at the top of the screen.
    if (Date.now() - (watchOnScreen.get(screenKey) ?? 0) < WATCH_ON_SCREEN_MS) { log(`clip ${clipId}: push skipped, watch app open on the chat`); return; }
    notifyReply(pushChat, chat, r.text);
   } catch (err) {
    // The answer came but storing or speaking it failed: don't leave the watch waiting on it.
    log(`clip ${clipId}: reply handling failed: ${err.message}`);
    try { store.update(clipId, { reply_status: 'none' }); } catch {}
   }
  }, (err) => { store.update(clipId, { reply_status: 'none' }); log(`clip ${clipId}: reply wait failed: ${err.message}`); });
}

/** The reply as speech: DATA/tts/<clip>.mp3 and its length in seconds, or null. */
async function speakReply(clipId, text) {
  const words = speakable(text).slice(0, 1500);
  if (!words) return null;
  const t0 = Date.now();
  const mp3 = await synthesize(RELAY, happy.credentials.token, words);
  if (!mp3) { log(`clip ${clipId}: speech failed`); return null; }
  fs.mkdirSync(TTS_DIR, { recursive: true });
  const file = path.join(TTS_DIR, `${clipId}.mp3`);
  fs.writeFileSync(file, mp3);
  // Two replies can finish together and prune the same files: a file already gone sorts last.
  const mtime = (name) => { try { return fs.statSync(path.join(TTS_DIR, name)).mtimeMs; } catch { return 0; } };
  const byNewest = fs.readdirSync(TTS_DIR).map((name) => ({ name, at: mtime(name) })).sort((a, b) => b.at - a.at);
  for (const old of byNewest.slice(50)) fs.rmSync(path.join(TTS_DIR, old.name), { force: true });
  const sec = await new Promise((resolve) => execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    (err, out) => resolve(err ? null : Math.round(Number(out) * 10) / 10 || null)));
  log(`clip ${clipId}: speech ${sec ?? '?'} s (${Date.now() - t0} ms)`);
  return sec;
}

/** A push with the reply; Claudeputer mirrors it to the watch when the phone is locked.
 *  Tapping it opens the chat (sessionId null: a T3 thread, which Claudeputer can't open). */
function notifyReply(sessionId, chat, text) {
  const plain = text.replace(/```[\s\S]*?```/g, '[code]').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  execFile(NOTIFY, [...(sessionId ? ['--chat', sessionId] : []), '-t', `⌚ ${chat}`, '-p', plain.slice(0, 300)], { timeout: 20000 }, (err, out) => {
    if (err) log(`reply push failed: ${err.message}`); else if (!/Sent/.test(out)) log(`reply push: ${out.trim()}`);
  });
}

/** Why the note ended and how long the mic sat paused in it, as the watch reports them (1.0.43+). */
function noteEnd(headers) {
  const by = String(headers['x-ended-by'] || '');
  const paused = Number(headers['x-paused-ms']);
  return { endedBy: /^[a-z-]{1,20}$/.test(by) ? by : null, pausedMs: Number.isFinite(paused) && paused > 0 ? Math.round(paused) : null };
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtClock = (iso) => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
/** The log page: notes, and failed requests (lib/netlog.mjs) in time order among them. */
function renderLog(rows, failures = []) {
  const fmtTime = (iso) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtFull = (iso) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const note = (r) => `<div class="row ${esc(r.status)}">
    <div class="meta">${esc(fmtTime(r.received_at))} · ${r.recorded_sec ?? '?'} s · ${esc(r.engine ?? '')} · ${esc(r.status)}${r.release_to_ack_ms ? ` · ${(r.release_to_ack_ms / 1000).toFixed(1)} s to send` : ''}${r.chat ? ` · ${esc(r.chat)}` : ''}${r.ended_by ? ` · ended by ${esc(r.ended_by)}` : ''}${r.paused_ms ? ` · mic paused ${(r.paused_ms / 1000).toFixed(1)} s` : ''}${r.steer === '1' ? ' · steer' : ''}</div>
    <div class="text">${esc(r.corrected || r.raw || '')}</div>
    ${r.raw && r.corrected && r.raw !== r.corrected ? `<div class="raw">heard: ${esc(r.raw)}</div>` : ''}
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}</div>`;
  const fail = (f) => `<div class="row fail"><div class="meta">${esc(fmtFull(f.at))} · failed request</div>
    <div class="err">${esc(describeFailure(f, fmtClock))}</div>${f.detail && f.source === 'watch' ? `<div class="raw">${esc(f.detail)}</div>` : ''}</div>`;
  const all = [...rows.map((r) => ({ at: r.received_at, html: note(r) })), ...failures.map((f) => ({ at: f.at, html: fail(f) }))]
    .sort((a, b) => b.at.localeCompare(a.at));
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claudeputer Dictation log</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#111;color:#eee}h1{font-size:18px}
.row{border-bottom:1px solid #333;padding:10px 0}.meta{color:#999;font-size:12px}.text{margin-top:4px}.raw{color:#888;font-size:12px;margin-top:2px}
.err{color:#f77;font-size:12px}.error .meta{color:#f77}.fail .meta{color:#c96}</style><h1>Claudeputer Dictation log</h1>${all.map((x) => x.html).join('') || '<p>No dictations yet.</p>'}`;
}

// Last app version seen from each device, so the phone can show what's installed where.
const VERSIONS_FILE = path.join(DATA, 'versions.json');
const WIDGET_FILE = path.join(DATA, 'widget.json');
const readVersions = () => { try { return JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8')); } catch { return {}; } };
let versions = readVersions();
function noteVersion(req) {
  const version = String(req.headers['x-app-version'] || '').slice(0, 40);
  const device = { watchOS: 'watch', iOS: 'phone' }[req.headers['x-app-platform']];
  if (!version || !device || version.endsWith('(1)')) return;   // (1): a local debug build, e.g. the simulator
  const changed = versions[device]?.version !== version;
  const last = Date.parse(versions[device]?.at || 0);
  if (!changed && Date.now() - last < 60_000) return;
  versions = { ...versions, [device]: { version, at: new Date().toISOString() } };
  fs.writeFileSync(VERSIONS_FILE, JSON.stringify(versions, null, 2));
  if (changed) log(`${device} app is now ${version}`);
}

/** /history for the T3 thread: same answer shape, same long-poll, by re-reading every few seconds
 *  (T3 has no push we can listen to with this login). */
async function t3History(req, res, q, wanted) {
  let target;
  try { target = t3Target(wanted); } catch (err) { return reply(res, err.status, { error: err.message }); }
  const { threadId, title } = target;
  const key = `t3:${threadId}`;
  const fromWatch = req.headers['x-app-platform'] === 'watchOS';
  if (fromWatch) watchOnScreen.set(key, Infinity);
  res.on('close', () => { if (fromWatch) watchOnScreen.set(key, Date.now()); });
  const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 40);
  const until = Date.now() + Math.min(Math.max(Number(q.get('wait')) || 0, 0), 25) * 1000;
  let r;
  try {
    for (;;) {
      const { thread, items: messages } = await t3().latestMessages(threadId, limit * 2);
      const { items, working } = t3HistoryItems(messages, thread, { limit });
      const version = createHash('sha1').update(JSON.stringify([key, items, working?.line ?? (working ? '' : null), thread.title, t3Flag(thread)])).digest('hex').slice(0, 12);
      r = { chat: thread.title || title, version, items, working, flag: t3Flag(thread) };
      if (version !== q.get('v') || Date.now() >= until || res.destroyed) break;
      await new Promise((done) => setTimeout(done, Math.min(3000, Math.max(0, until - Date.now()))));
    }
  } catch (err) {
    log(`t3 history: ${err.message}`);
    return reply(res, 503, { error: 'T3 is not answering' });
  }
  return reply(res, 200, r);
}

function authorized(req) {
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  return got.length === TOKEN.length && timingSafeEqual(got, TOKEN);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Clip too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => { err.received = size; reject(err); });
  });
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const route = req.url.split('?')[0];
  const startedAt = Date.now();
  try {
    if (req.method === 'GET' && route === '/health') return reply(res, 200, { ok: true });
    // Log page for the tailnet (tailscale serve). Requests through Cloudflare carry
    // cf-connecting-ip and never get it; only the watch's service token passes Access anyway.
    if (req.method === 'GET' && route === '/log' && !req.headers['cf-connecting-ip']) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const rows = store.recent(200);
      return res.end(renderLog(rows, store.failures({ since: rows.length === 200 ? rows.at(-1).received_at : null, limit: 500 })));
    }
    const known = { GET: ['/settings', '/recent', '/chats', '/t3threads', '/dictionary', '/reply', '/widget', '/history', '/tts'], POST: ['/event', '/widget', '/dictate', '/timing', '/settings', '/status', '/netlog'] };
    if (!known[req.method]?.includes(route)) return reply(res, 404, { error: 'not found' });
    if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' });
    noteVersion(req);

    if (route === '/settings') {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        const next = readSettings();
        if (['deepgram', 'local'].includes(body.engine)) next.engine = body.engine;
        if (typeof body.autoStart === 'boolean') next.autoStart = body.autoStart;
        if (typeof body.continuous === 'boolean') next.continuous = body.continuous;
        if (TAGS.includes(body.tag)) next.tag = body.tag;
        if (typeof body.replyWatch === 'boolean') next.replyWatch = body.replyWatch;
        if (typeof body.replyPush === 'boolean') next.replyPush = body.replyPush;
        if (SPEAK.includes(body.speak)) next.speak = body.speak;
        if (MID_TURN.includes(body.midTurn)) next.midTurn = body.midTurn;
        if (VOICES.includes(body.voice)) await setVoiceSetting(RELAY, happy.credentials.token, body.voice).catch((e) => log(`voice not saved: ${e.message}`));
        if (Array.isArray(body.extras)) {
          const listing = await readListing(happy, log);
          const main = await mainEntry(happy, listing, chatTitles);
          const asked = [...new Set(body.extras.filter((x) => typeof x === 'string' && /^[A-Za-z0-9]{8,64}$/.test(x)))];
          next.extras = cappedExtras(asked, listing, main);
        }
        writeSettings(next);
        log(`settings: engine=${next.engine}`);
      }
      const listing = await readListing(happy, log);
      const chats = await watchChats(listing);
      const asked = new URL(req.url, 'http://x').searchParams.get('selected');
      const selected = asked && asked !== 'main' && !isT3Wire(asked) && /^[A-Za-z0-9-]{8,64}$/.test(asked) ? await selectedEntry(happy, asked, listing, chatTitles) : undefined;
      const voice = await voiceSetting(RELAY, happy.credentials.token);
      const { legacyMain, ...shown } = readSettings();
      return reply(res, 200, {
        ...shown, snapBack: false, voice, versions, server: env.WATCH_DICTATE_PUBLIC_URL || '',
        destinations: chats, main: await mainEntry(happy, listing, chatTitles), selected, t3Enabled: !!t3Config(), legacyTargets: await legacyTargets(chats),
        chats: await oldBuildChats(chats),   // builds before 1.0.42 only
      });
    }
    if (route === '/chats') {
      const all = await happy.allSessions();
      const rows = all
        .filter((s) => !isArchived(s.metadata))
        .sort((a, b) => (b.activeAt || b.updatedAt || 0) - (a.activeAt || a.updatedAt || 0))
        .slice(0, 25)
        .map((s) => ({ id: s.id, title: title(s.metadata), host: s.metadata?.host, active: !!s.active }));
      return reply(res, 200, { chats: rows });
    }
    // The T3 screen on the watch and iPhone. Read-only, and it fills itself.
    if (route === '/t3threads') {
      if (!t3Config()) return reply(res, 200, { threads: [], stale: false });
      const { threads, projects, stale } = await t3Threads();
      const q = new URL(req.url, 'http://x').searchParams;
      const selectedId = parseT3Target(q.get('selected'), t3Config().threadId);
      const selected = selectedId && !stale ? await t3Thread(selectedId).catch(() => null) : null;
      return reply(res, 200, { threads: t3ThreadRows(threads, { selected, projects }), stale });
    }
    // The watch's status widget state (current chat, last note), posted by the app and read
    // by the widget extension, which shares no storage with it.
    // Watch events worth tracing later: Continuous ending and why, mic cut-offs, restarts.
    if (route === '/event') {
      const e = JSON.parse((await readBody(req, 4096)).toString('utf8'));
      const name = String(e.event || '').slice(0, 40), detail = String(e.detail || '').slice(0, 200);
      log(`watch event: ${name}${detail ? ` (${detail})` : ''}`);
      append({ type: 'watch-event', at: new Date().toISOString(), event: name, detail });
      return reply(res, 200, { ok: true });
    }
    if (route === '/widget') {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        fs.writeFileSync(WIDGET_FILE, JSON.stringify(body));
        return reply(res, 200, { ok: true });
      }
      try { return reply(res, 200, JSON.parse(fs.readFileSync(WIDGET_FILE, 'utf8'))); } catch { return reply(res, 404, { error: 'no state yet' }); }
    }
    if (route === '/reply') {
      const clip = new URL(req.url, 'http://x').searchParams.get('clip') || '';
      const r = store.get(clip);
      if (!r) return reply(res, 404, { error: 'unknown clip' });
      return reply(res, 200, { status: r.reply_status || 'off', text: r.reply, chat: r.chat, at: r.reply_at, audioSec: r.reply_audio_sec ?? null });
    }
    if (route === '/tts') {
      const clip = new URL(req.url, 'http://x').searchParams.get('clip') || '';
      if (!/^[A-Za-z0-9-]{8,64}$/.test(clip)) return reply(res, 400, { error: 'bad clip' });
      const file = path.join(TTS_DIR, `${clip}.mp3`);
      if (!fs.existsSync(file)) return reply(res, 404, { error: 'no speech for that clip' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return res.end(fs.readFileSync(file));
    }
    // The watch's chat page: the last messages of the chat notes go to. With ?v= (the version
    // the watch has) and ?wait= (seconds) it holds the request until the chat changes.
    if (route === '/history') {
      const q = new URL(req.url, 'http://x').searchParams;
      const wanted = q.get('chat');
      if (!wanted) return reply(res, 400, { error: 'no chat named' });
      if (isT3Wire(wanted)) return await t3History(req, res, q, wanted);
      const { id: sid, session, title: chatTitle } = await happyTarget(wanted);
      const fromWatch = req.headers['x-app-platform'] === 'watchOS';
      if (fromWatch) watchOnScreen.set(sid, Infinity);
      res.on('close', () => { if (fromWatch) watchOnScreen.set(sid, Date.now()); });
      const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 40);
      const until = Date.now() + Math.min(Math.max(Number(q.get('wait')) || 0, 0), 25) * 1000;
      let r;
      for (;;) {
        const { items, working } = historyItems(await history.messages(session).catch((err) => { throw /HTTP 404/.test(err.message) ? heldError(GONE) : err; }), { limit });
        const version = createHash('sha1').update(JSON.stringify([sid, items, working?.line ?? (working ? '' : null)])).digest('hex').slice(0, 12);
        r = { chat: chatTitle, version, items, working };
        if (version !== q.get('v') || Date.now() >= until || res.destroyed) break;
        await happy.waitForChange(sid, until - Date.now());
      }
      return reply(res, 200, r);
    }
    if (route === '/dictionary') {
      const s = await happy.settings();
      return reply(res, 200, { entries: (s.dictationDictionary ?? []).filter((e) => e.replacement !== undefined) });
    }
    if (route === '/recent') {
      const rows = store.recent(30).map((r) => ({
        // The iPhone labels anything but 'extra' as "(main)", so T3 goes out as an extra.
        id: r.clip_id, at: r.received_at, seconds: r.recorded_sec, engine: r.engine, chat: r.chat, targetKind: r.target_kind === T3_TARGET ? 'extra' : r.target_kind,
        text: r.corrected || r.raw || '', heard: r.raw, status: r.status,
        sendMs: r.release_to_ack_ms, error: r.error, reply: r.reply, replyStatus: r.reply_status,
      }));
      return reply(res, 200, { settings: readSettings(), dictations: rows });
    }

    if (route === '/status') {
      const t = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8'));
      if (!['recording', 'transcribing', 'idle'].includes(t.state)) return reply(res, 400, { error: 'bad state' });
      if (!t.target) return reply(res, 400, { error: 'no chat named' });
      await dictationStatus({ ...t, clipId: String(t.clipId || '').slice(0, 64) });
      return reply(res, 200, { ok: true });
    }
    // The watch's failed requests, sent with the first request that works after them. Each record
    // has the watch's own id, so a resend after a lost answer adds nothing.
    if (route === '/netlog') {
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
      const version = String(req.headers['x-app-version'] || '');
      let added = 0;
      for (const raw of (Array.isArray(body.failures) ? body.failures : []).slice(0, 100)) {
        const row = watchFailureRow(raw, { version });
        if (row && store.addFailure(row)) { added++; log(`watch failure: ${describeFailure(row, fmtClock)}`); }
      }
      return reply(res, 200, { ok: true, added });
    }
    if (route === '/timing') {
      const t = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
      append({ type: 'watch-timing', at: new Date().toISOString(), ...t });
      if (t.clipId) store.update(String(t.clipId), { release_to_ack_ms: t.releaseToAckMs, network: t.network });
      return reply(res, 200, { ok: true });
    }

    const clipId = String(req.headers['x-clip-id'] || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clipId)) return reply(res, 400, { error: 'missing or bad X-Clip-Id' });
    if (results.has(clipId)) { await readBody(req, MAX_BODY); return reply(res, 200, { ...results.get(clipId), replay: true }); }
    const audio = await readBody(req, MAX_BODY);
    if (audio.length < 100) return reply(res, 400, { error: 'empty clip' });
    // Never guessed. 409, not 400: the watch keeps a clip on 409 and drops it on 400.
    const wanted = String(req.headers['x-target'] || '');
    if (!wanted) return reply(res, 409, { error: 'Pick a chat for this note' });
    // The watch sends its choice with each clip; the shared setting covers older builds.
    const asked = req.headers['x-engine'] || readSettings().engine;
    const engine = asked === 'local' ? 'local' : 'deepgram';
    const meta = { recordMs: Number(req.headers['x-duration-ms']) || null, engine, target: wanted, auto: req.headers['x-auto'] === '1', autoHeader: req.headers['x-auto'], ...noteEnd(req.headers) };
    if (!inflight.has(clipId)) {
      const p = processClip(clipId, audio, meta).finally(() => inflight.delete(clipId));
      inflight.set(clipId, p);
    }
    // Cloudflare drops a request after ~100 s without a reply. A long note answers
    // "accepted" at 60 s and keeps transcribing; it posts to the chat when done.
    const job = inflight.get(clipId);
    let timer;
    const result = await Promise.race([job, new Promise((r) => { timer = setTimeout(() => r(null), REPLY_WAIT_MS); })]);
    clearTimeout(timer);
    if (!result) {
      // The watch deletes its copy on this answer, so the note is on disk here before it's given.
      // Once per clip: a second request for the same clip joins the same job.
      if (!accepted.has(clipId)) {
        accepted.save(clipId, audio, meta);
        job.then((r) => { remember(clipId, r); acceptedSettled(clipId, null); log(`clip ${clipId} -> ${r.empty ? '(empty)' : `"${r.chat}"`} (after accepting) ${r.timings ? JSON.stringify(r.timings) : ''}`); },
          (err) => { log(`clip ${clipId} failed after accepting: ${err.message}`); acceptedSettled(clipId, err); })
          .catch((err) => log(`clip ${clipId}: accepted note bookkeeping failed: ${err.message}`));
      }
      log(`clip ${clipId} accepted, still transcribing`);
      return reply(res, 202, { ok: true, accepted: true });
    }
    remember(clipId, result);
    log(`clip ${clipId} -> ${result.empty ? '(empty)' : `"${result.chat}"`} ${result.timings ? JSON.stringify(result.timings) : ''}`);
    return reply(res, 200, result);
  } catch (err) {
    log(`error ${route}: ${err.message}`);
    // The upload stopped before its body arrived: the watch gave up, or the link dropped.
    if (route === '/dictate' && err.received !== undefined) {
      const clipId = String(req.headers['x-clip-id'] || '').slice(0, 64);
      try {
        const row = serverAbortRow({ clipId, startedAt, received: err.received, expected: req.headers['content-length'], error: err.message, version: req.headers['x-app-version'] });
        store.addFailure(row);
        log(`  ${describeFailure(row)}`);
      } catch (e) { log(`net failure not logged: ${e.message}`); }
    }
    if (res.headersSent || res.destroyed) return;
    return reply(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => log(`watch-dictate listening on 127.0.0.1:${PORT}`));
