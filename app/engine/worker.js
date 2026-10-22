// The engine's home: a module Worker that loads the model and transcribes, off the page's main
// thread.
//
// Load: fusor-ai's worker kit (`dist/host/worker.js`) starts the best runtime build and streams
// every part of the bundle into it; the runtime checks each part's size and BLAKE3.
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

import { engine, load, post, ready, report, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

// New live audio, in seconds, worth another update.
const MIN_FRESH_SECONDS = 0.5;

// The engine once every part is in: live audio heard before then waits in the session.
let runtime = null;
let sampleRate = 0;
let stoppedJob = null;
// The live session: its job, the audio not yet heard by the runtime, and its measurements.
let live = null;

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'parakeet_runtime',
      cacheName: 'parakeet-parts',
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => {
        sampleRate = started.glue.sample_rate();
        post({ type: 'runtime', build: started.build.name, threads: started.threads });
      },
      onReady: (progress) => {
        runtime = engine;
        post({ type: 'ready', ...progress });
      },
    }),
  listen,
  transcribe,
  stop,
});

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
    if (live === session) live = null;
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
