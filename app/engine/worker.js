// The engine's home: a module Worker that loads the model and transcribes, off the page's main
// thread.
//
// Load: the manifest download overlaps the runtime's compile; fusor-ai's loader picks and starts
// the best runtime build (threaded builds get their compute workers from the page) and streams
// every part of the bundle into it, from OPFS when cached there, else from the network; the
// runtime checks each part's size and BLAKE3. The runtime itself does no I/O.
//
// Listen: the capture worklet posts 16 kHz audio straight here through a MessagePort. Each piece
// is heard as it arrives; whenever `MIN_FRESH_SECONDS` of new audio are in and no update is
// running, `update()` commits the segments that are ready and transcribes the rest again, and its
// text goes to the page with the mean delay from the newest audio of an update to its text. Audio
// heard before the model is ready is kept and read once it is.
//
// Transcribe: a decoded recording is cut into segments (`start()`), then one `step()` (one
// segment) per macrotask, so a stop request is seen between segments.
//
// After the model is loaded nothing else is fetched: transcription is entirely local.

import { describe, errorKind, fetchOk, loadParts, startRuntime } from './dist/host/loader.js';

const CACHE_DIR = 'parakeet-parts';
const DIST_URL = new URL('./dist/', import.meta.url);
// New live audio, in seconds, worth another update.
const MIN_FRESH_SECONDS = 0.5;

const post = (message, transfer) => self.postMessage(message, transfer ?? []);
// A macrotask without setTimeout's 4 ms clamp on nested timers. Listening and stopping wait on
// it at once, so each wait has its own place in line.
const ticks = new MessageChannel();
const waiting = [];
ticks.port1.onmessage = () => waiting.shift()();
const yieldTask = () => new Promise((resolve) => {
  waiting.push(resolve);
  ticks.port2.postMessage(null);
});

let runtime = null;
let resolveReady;
const ready = new Promise((resolve) => (resolveReady = resolve));
let sampleRate = 0;
let stoppedJob = null;
// The live session: its job, the audio not yet heard by the runtime, and its measurements.
let live = null;
// When the model was ready: every request this worker starts later is made while transcribing
// (the page shows the count; it should stay 0). A part's own entry can land after it.
let readyAt = Infinity;
const requestsSinceReady = () => performance.getEntriesByType('resource').filter((entry) => entry.startTime >= readyAt).length;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data);
    else if (data.type === 'listen') listen(data);
    else if (data.type === 'transcribe') await transcribe(data);
    else if (data.type === 'stop') await stop(data);
  } catch (error) {
    report(error, data.job);
  }
};

/** A runtime error is `{"kind","message"}` JSON and leaves the engine usable. Anything else is a
 * trap (the runtimes abort on panic) or a bug: the module's state is lost. */
function report(error, job) {
  if (live?.job === job) live = null;
  post({ type: errorKind(error) ? 'error' : 'fatal', job, message: describe(error, runtime?.glue) });
}

async function load({ modelUrl, threads, build: requested }) {
  const t0 = performance.now();
  const [manifestText, started] = await Promise.all([
    fetchOk(new URL('manifest.json', modelUrl)).then((response) => response.text()),
    startRuntime({
      distUrl: DIST_URL,
      glueName: 'parakeet_runtime',
      threads,
      requested,
      onWarning: (message) => post({ type: 'warning', message }),
    }),
  ]);
  const rt = new started.glue.Runtime(manifestText);
  sampleRate = started.glue.sample_rate();
  post({ type: 'runtime', build: started.build.name, threads: started.threads });
  const progress = await loadParts({
    runtime: rt,
    manifest: JSON.parse(manifestText),
    baseUrl: modelUrl,
    cacheName: CACHE_DIR,
    onProgress: (p) => post({ type: 'progress', ...p }),
  });
  runtime = { rt, glue: started.glue };
  readyAt = performance.now();
  post({ type: 'ready', ms: performance.now() - t0, ...progress });
  resolveReady();
  await evictStaleParts(JSON.parse(manifestText));
}

/** Deletes cached parts this bundle does not name: those of earlier bundles. */
async function evictStaleParts(manifest) {
  const keep = new Set(manifest.parts.map((part) => part.blake3));
  let dir;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR);
  } catch {
    return; // no OPFS, or nothing was cached
  }
  for await (const name of dir.keys()) {
    if (!keep.has(name)) await dir.removeEntry(name);
  }
}

function listen({ job, port }) {
  live = { job, port, waiting: [], fresh: 0, heardAt: 0, computeMs: 0, delayMs: 0, updates: 0, running: false };
  port.onmessage = ({ data: samples }) => hear(job, samples);
  ready.then(() => {
    if (live?.job !== job) return;
    runtime.rt.listen();
    for (const samples of live.waiting.splice(0)) runtime.rt.hear(samples);
    post({ type: 'started', job });
    pump(live);
  });
}

function hear(job, samples) {
  if (live?.job !== job) return;
  live.heardAt = performance.now();
  live.fresh += samples.length;
  if (!runtime) return void live.waiting.push(samples);
  runtime.rt.hear(samples);
  pump(live);
}

/** Updates `session` while enough new audio keeps arriving, one update per macrotask. */
async function pump(session) {
  if (session.running) return;
  session.running = true;
  try {
    while (live === session && session.fresh >= MIN_FRESH_SECONDS * sampleRate) {
      session.fresh = 0;
      const heardAt = session.heardAt;
      const t0 = performance.now();
      const update = JSON.parse(runtime.rt.update());
      session.computeMs += performance.now() - t0;
      session.delayMs += performance.now() - heardAt;
      session.updates++;
      const delayMs = session.delayMs / session.updates;
      post({ type: 'text', job: session.job, ...update, computeMs: session.computeMs, delayMs, networkRequests: requestsSinceReady() });
      await yieldTask();
    }
  } catch (error) {
    report(error, session.job);
  } finally {
    session.running = false;
  }
}

async function stop({ job }) {
  if (live?.job !== job) {
    stoppedJob = job;
    return;
  }
  live.port.close();
  const session = live;
  live = null;
  await ready;
  while (session.running) await yieldTask();
  const t0 = performance.now();
  const update = JSON.parse(runtime.rt.finish());
  const computeMs = session.computeMs + performance.now() - t0;
  post({ type: 'done', job, stopped: false, ...update, computeMs, networkRequests: requestsSinceReady() });
}

async function transcribe({ job, pcm }) {
  await ready;
  if (stoppedJob === job) return post({ type: 'done', job, stopped: true, committed: [], heard: 0, computeMs: 0 });
  const { rt } = runtime;
  let t0 = performance.now();
  const plan = JSON.parse(rt.start(pcm));
  let computeMs = performance.now() - t0;
  post({ type: 'started', job, segments: plan.segments.length });
  for (;;) {
    if (stoppedJob === job) {
      rt.cancel();
      return post({ type: 'done', job, stopped: true, committed: [], heard: plan.seconds, computeMs, networkRequests: requestsSinceReady() });
    }
    t0 = performance.now();
    const progress = JSON.parse(rt.step());
    computeMs += performance.now() - t0;
    const heard = progress.done ? plan.seconds : plan.segments[progress.segment]?.end ?? plan.seconds;
    const stats = { heard, computeMs, networkRequests: requestsSinceReady() };
    if (progress.done) return post({ type: 'done', job, stopped: false, committed: progress.sentences, ...stats });
    post({ type: 'text', job, committed: progress.sentences, provisional: [], segment: progress.segment, segments: progress.segments, ...stats });
    await yieldTask();
  }
}
