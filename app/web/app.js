import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';
import { Waveform } from './waveform.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the engine
// worker and, in threaded builds, its compute workers (fusor-ai's ComputePool), the microphone
// and its capture worklet (engine/capture.js), which posts 16 kHz audio straight to the engine
// worker, and the decoding of chosen files. It measures each transcription and reports back with
// `engine` events, at most once per animation frame.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// One compute worker per core minus two (the page and the engine worker), at most 8; `?threads=1`
// forces the single-threaded build. Never more than the cores: the barriers spin.
const requestedThreads = Number.parseInt(params.get('threads') ?? '', 10);
const THREADS = Math.min(cores, requestedThreads > 0 ? requestedThreads : Math.max(1, Math.min(8, cores - 2)));
// The bundle served next to the page (`just serve` mounts dist/model there); `?model=<url>` loads
// another one, `?build=web-single` pins a runtime build.
const MODEL_URL = new URL(params.get('model') ?? 'model/', document.baseURI).href;
// The rate the model reads; the microphone's context and decoded files are resampled to it.
const SAMPLE_RATE = 16_000;
// Waveform bars per second of a decoded file, and the bars of live audio shown (the capture
// worklet's levels of the last 20 s).
const FILE_PEAKS_PER_SECOND = 20;
const LIVE_PEAKS = 400;
// The transcript keeps its newest words in view unless the reader scrolled further up than this.
const FOLLOW_SLACK_PX = 48;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export function onMount({ root, inputs, onCleanup }) {
  const report = (detail) => root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(detail) }));
  const engine = new Worker(new URL('engine/worker.js', document.baseURI), { type: 'module', name: 'parakeet-engine' });
  const computePool = new ComputePool(crash);
  const waveform = new Waveform(root);
  let build = null;
  let notice = '';
  let loaded = false;
  let broken = false;
  let jobs = 0;
  let job = null;
  let input = null;
  let microphone = null;
  let readyAt = Infinity;

  const handlers = {
    [SPAWN_COMPUTE]: (message) => computePool.spawn(message),
    runtime: (message) => {
      build = message;
      // Built as the runtime starts, suspended until Listen: listening does not wait for the
      // context and the worklet module, and nothing is fetched once the model is ready.
      capture();
    },
    warning: ({ message }) => {
      console.warn(message);
      notice = ` (${message})`;
    },
    progress: ({ done, total, network, cache }) => {
      const source = cache && !network ? 'from this device' : cache ? `${mb(network)} downloaded, ${mb(cache)} cached` : 'downloading';
      report({ type: 'loading', fraction: done / total, detail: `${mb(done)} / ${mb(total)} · ${source}` });
    },
    ready: ({ ms, cache, total }) => {
      loaded = true;
      readyAt = performance.now();
      const loadedInfo = { build: `${build.build}${notice}`, threads: build.threads, bundle_bytes: total, load_ms: ms, from_device: cache === total };
      report({ type: 'ready', loaded: loadedInfo });
    },
    started: (message) => {
      if (message.job !== job?.id) return;
      const status = job.mode === 'listening' ? 'Listening: speak, the words follow.' : `Transcribing ${message.segments} segment${message.segments === 1 ? '' : 's'}…`;
      report({ type: 'started', phase: job.mode, status });
    },
    text: (message) => {
      if (message.job !== job?.id) return;
      job.engine = message;
      job.delayMs = message.delayMs ?? (job.delayMs ?? performance.now() - job.t0);
      if (job.mode === 'transcribing') waveform.play(message.heard / job.seconds);
      const status = job.mode === 'listening' ? `Listening · ${message.heard.toFixed(1)} s heard` : `Transcribing · segment ${message.segment + 1} of ${message.segments}`;
      follow(() => report({ type: 'text', committed: message.committed, provisional: message.provisional, status, metrics: metrics() }));
    },
    done: (message) => {
      if (message.job !== job?.id) return;
      job.engine = message;
      waveform.play(1);
      const status = job.mode === 'listening' ? 'Stopped listening.' : 'Done.';
      report({ type: 'text', committed: message.committed, provisional: [], status, metrics: metrics() });
      report({ type: 'done', status: message.stopped ? 'Stopped.' : status, metrics: metrics() });
      job = null;
    },
    error: ({ message }) => {
      if (!loaded) return fail(message);
      closeMicrophone();
      job = null;
      report({ type: 'error', message });
    },
    fatal: ({ message }) => fail(message),
  };

  engine.onmessage = ({ data }) => {
    if (!broken) handlers[data.type]?.(data);
  };
  engine.onerror = (event) => crash(event.message || 'the engine worker failed');
  engine.postMessage({ type: 'load', modelUrl: MODEL_URL, threads: THREADS, build: params.get('build') });

  function begin(mode) {
    job = { id: ++jobs, mode, t0: performance.now(), engine: null, delayMs: null, seconds: 0 };
    waveform.reset(mode === 'listening' ? LIVE_PEAKS : Infinity);
    return job;
  }

  /** The microphone's path, built once: a 16 kHz context and the capture worklet, its output silent. */
  function capture() {
    input ??= (async () => {
      const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      await context.audioWorklet.addModule(new URL('engine/capture.js', document.baseURI));
      const node = new AudioWorkletNode(context, 'parakeet-capture', { outputChannelCount: [1] });
      node.connect(context.destination);
      node.port.onmessage = ({ data }) => waveform.push(data.peaks);
      return { context, node };
    })();
    return input;
  }

  /** Opens the microphone and streams it to the engine through the capture worklet. */
  async function listen() {
    const current = begin('listening');
    try {
      const { context, node } = await capture();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      const source = context.createMediaStreamSource(stream);
      microphone = { stream, source, context };
      if (current !== job) return closeMicrophone();
      source.connect(node);
      const channel = new MessageChannel();
      node.port.postMessage({ type: 'engine', port: channel.port1 }, [channel.port1]);
      engine.postMessage({ type: 'listen', job: current.id, port: channel.port2 }, [channel.port2]);
      await context.resume();
      if (!loaded) report({ type: 'started', phase: 'listening', status: 'Listening: the words follow once the model is ready.' });
    } catch (error) {
      closeMicrophone();
      job = null;
      report({ type: 'error', message: `no microphone (${error?.message ?? error})` });
    }
  }

  /** Decodes the chosen file to 16 kHz mono and hands it to the engine. */
  async function transcribeFile() {
    const current = begin('transcribing');
    const file = root.querySelector('#file').files[0];
    try {
      if (!file) throw new Error('no file chosen');
      const encoded = await file.arrayBuffer();
      const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(encoded);
      const pcm = mono(decoded);
      current.seconds = pcm.length / SAMPLE_RATE;
      waveform.push(peaks(pcm, Math.ceil(current.seconds * FILE_PEAKS_PER_SECOND)));
      if (current !== job) return;
      engine.postMessage({ type: 'transcribe', job: current.id, pcm }, [pcm.buffer]);
      if (!loaded) report({ type: 'started', phase: 'transcribing', status: `${file.name}: transcribed once the model is ready.` });
    } catch (error) {
      job = null;
      report({ type: 'error', message: `could not read ${file?.name ?? 'the file'} (${error?.message ?? error})` });
    } finally {
      root.querySelector('#file').value = '';
    }
  }

  function stop() {
    if (!job) return;
    closeMicrophone();
    engine.postMessage({ type: 'stop', job: job.id });
  }

  function closeMicrophone() {
    microphone?.source.disconnect();
    microphone?.stream.getTracks().forEach((track) => track.stop());
    microphone?.context.suspend();
    microphone = null;
  }

  async function copy() {
    const text = [...root.querySelectorAll('.sentence span')].map((span) => span.textContent).join(' ');
    await navigator.clipboard.writeText(text).catch(() => {}); // a refused clipboard has nothing to report
  }

  /** Runs `update`, then scrolls the transcript to its end if it was showing its end before. */
  function follow(update) {
    const box = root.querySelector('.sentences');
    const following = !box || box.scrollHeight - box.scrollTop - box.clientHeight < FOLLOW_SLACK_PX;
    update();
    if (following) requestAnimationFrame(() => root.querySelector('.sentences')?.scrollTo({ top: Number.MAX_SAFE_INTEGER }));
  }

  function metrics() {
    const engineStats = job?.engine ?? { heard: 0, computeMs: 0, networkRequests: 0 };
    const ownRequests = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= readyAt).length;
    const requests = ownRequests + (engineStats.networkRequests ?? 0);
    return { audio_seconds: engineStats.heard, compute_ms: engineStats.computeMs, delay_ms: job?.delayMs ?? null, requests };
  }

  /** The model could not load, or the engine or a compute thread died. */
  function fail(message) {
    broken = true;
    closeMicrophone();
    engine.terminate();
    computePool.terminate();
    report({ type: 'broken', message });
  }

  function crash(message) {
    fail(`The engine stopped: ${message}.`);
  }

  onCleanup(onClicks(inputs.listens, listen));
  onCleanup(onClicks(inputs.files, transcribeFile));
  onCleanup(onClicks(inputs.stops, stop));
  onCleanup(onClicks(inputs.copies, copy));
  onCleanup(() => {
    closeMicrophone();
    input?.then(({ context }) => context.close());
    engine.terminate();
    computePool.terminate();
  });
}

/** The channels of a decoded file averaged. */
function mono(buffer) {
  const out = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    buffer.getChannelData(channel).forEach((sample, i) => (out[i] += sample / buffer.numberOfChannels));
  }
  return out;
}

/** The largest magnitude of each of `count` equal stretches of `samples`. */
function peaks(samples, count) {
  const out = new Float32Array(count);
  const width = Math.ceil(samples.length / count);
  samples.forEach((sample, i) => {
    const bin = Math.floor(i / width);
    out[bin] = Math.max(out[bin], Math.abs(sample));
  });
  return out;
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
