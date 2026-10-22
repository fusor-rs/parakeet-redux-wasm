// Runs a single-threaded wasm runtime build in Node against a bundle: pushes every part the way
// the browser loader does, then transcribes one recording twice, as a file (cut at its pauses,
// one segment per step) and as live audio (heard in pieces, updated after each), and prints for
// each the real-time factor and the word error rate against the recording's reference. With
// `--out`, each transcript is written to `<dir>/<mode>.txt`.
//
//   node scripts/node-smoke.mjs dist/model --build web-single [--recording fixtures/recordings/long.wav] [--out dir]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { wordErrorRate } from './wer.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'string', default: 'web-single' },
    recording: { type: 'string', default: 'fixtures/recordings/long.wav' },
    out: { type: 'string' },
  },
});
// Live audio arrives in pieces this long, as the page's capture worklet sends it.
const LIVE_PIECE_SECONDS = 0.5;

const bundle = positionals[0] ?? 'dist/model';
const dist = new URL(`../app/engine/dist/${values.build}/`, import.meta.url);
const glue = await import(new URL('parakeet_runtime.js', dist));
glue.initSync({ module: readFileSync(new URL('parakeet_runtime_bg.wasm', dist)) });

const CHUNK = 8 << 20;
const t0 = performance.now();
const manifest = readFileSync(join(bundle, 'manifest.json'), 'utf8');
const runtime = new glue.Runtime(manifest);
let ready = false;
JSON.parse(manifest).parts.forEach((part, index) => {
  const bytes = readFileSync(join(bundle, part.file));
  for (let o = 0; o < bytes.length; o += CHUNK) runtime.write_part(index, bytes.subarray(o, o + CHUNK));
  ready = runtime.end_part(index);
});
if (!ready) throw new Error('engine not ready after every part');
console.log(`${values.build}: load ${((performance.now() - t0) / 1000).toFixed(2)}s`);

const pcm = readWav(readFileSync(values.recording));
const seconds = pcm.length / glue.sample_rate();
const references = JSON.parse(readFileSync(join(dirname(values.recording), 'references.json'), 'utf8'));
const reference = references[basename(values.recording, '.wav')];
let failed = false;
if (values.out) mkdirSync(values.out, { recursive: true });

const report = (mode, ms, sentences, detail) => {
  const text = sentences.map((sentence) => sentence.text).join(' ');
  const { rate, errors, words } = wordErrorRate(reference, text);
  console.log(`  ${mode}: ${seconds.toFixed(2)}s of audio in ${(ms / 1000).toFixed(2)}s, RTF ${(ms / 1000 / seconds).toFixed(3)}, ${detail}; WER ${rate.toFixed(4)} (${errors}/${words})`);
  failed ||= !text;
  if (values.out) writeFileSync(join(values.out, `${mode}.txt`), `${text}\n`);
};

let t1 = performance.now();
const plan = JSON.parse(runtime.start(pcm));
const file = [];
for (let progress = { done: false }; !progress.done; ) {
  progress = JSON.parse(runtime.step());
  file.push(...progress.sentences);
}
report('file', performance.now() - t1, file, `${plan.segments.length} segments`);

t1 = performance.now();
runtime.listen();
const live = [];
const piece = Math.round(LIVE_PIECE_SECONDS * glue.sample_rate());
let updates = 0;
for (let at = 0; at < pcm.length; at += piece) {
  runtime.hear(pcm.subarray(at, at + piece));
  live.push(...JSON.parse(runtime.update()).committed);
  updates++;
}
live.push(...JSON.parse(runtime.finish()).committed);
report('live', performance.now() - t1, live, `${updates} updates`);
if (failed) process.exit(1);

/** The samples of a 16-bit PCM WAV file (the fixtures' format), channels averaged. */
function readWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let channels = 1;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') channels = view.getUint16(at + 10, true);
    if (id === 'data') {
      const frames = Math.floor(size / 2 / channels);
      const out = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < channels; channel++) out[frame] += view.getInt16(at + 8 + 2 * (frame * channels + channel), true) / 32768 / channels;
      }
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}
