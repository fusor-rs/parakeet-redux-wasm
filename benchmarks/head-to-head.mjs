// Native head-to-head on this machine's CPU: this repository's `parakeet` CLI against Moondream's
// Photon (moondream 2.6.1 and its kestrel engine, benchmarks/photon.py), both transcribing the
// fixed recordings (fixtures/recordings: the 73 LibriSpeech utterances and long.wav) with the same
// thread counts. Reports the real-time factor (compute time over audio time, lower is faster;
// Moondream's model card quotes the inverse) and the word error rate over all recordings
// (scripts/wer.mjs).
//
//   node benchmarks/head-to-head.mjs [--threads 1,8]
//
// Results go to benchmarks/out/<timestamp>.json.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { wordErrorRate } from '../scripts/wer.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RECORDINGS = join(ROOT, 'fixtures/recordings');
const PHOTON = ['run', '--no-project', '--python', '3.12', '--with', 'moondream==2.6.1', '--with', 'soundfile==0.14.0', 'python', join(ROOT, 'benchmarks/photon.py')];
const { values } = parseArgs({ options: { threads: { type: 'string', default: '1,8' } } });

const references = JSON.parse(readFileSync(join(RECORDINGS, 'references.json'), 'utf8'));
const names = readdirSync(RECORDINGS).filter((file) => file.endsWith('.wav')).map((file) => file.slice(0, -4)).sort();
const files = names.map((name) => join(RECORDINGS, `${name}.wav`));

/** Our CLI over every recording: its texts (each under a `# <file>` line) and its RTF line. */
function ours(threads) {
  const args = ['--threads', `${threads}`, 'transcribe', join(ROOT, 'dist/model'), ...files];
  const run = spawnSync(join(ROOT, 'target/release/parakeet'), args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(run.stderr);
  const texts = {};
  let current = null;
  for (const line of run.stdout.split('\n')) {
    if (line.startsWith('# ')) texts[(current = line.slice(2).split('/').pop().slice(0, -4))] = '';
    else if (current && line) texts[current] += `${line.replace(/^\[[^\]]*\] /, '')} `;
  }
  return { rtf: Number(/RTF ([\d.]+)/.exec(run.stderr)[1]), texts };
}

function photon(threads) {
  const result = JSON.parse(execFileSync('uv', [...PHOTON, '--threads', `${threads}`, ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  return { rtf: result.compute / result.audio, texts: result.texts };
}

function wer(texts) {
  const total = names.reduce((sum, name) => {
    const { errors, words } = wordErrorRate(references[name], texts[name] ?? '');
    return { errors: sum.errors + errors, words: sum.words + words };
  }, { errors: 0, words: 0 });
  return total.errors / total.words;
}

const results = { machine: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(), runs: [] };
for (const threads of values.threads.split(',').map(Number)) {
  for (const [runtime, run] of [['parakeet-redux-wasm (native CLI)', ours], ['Photon (moondream 2.6.1)', photon]]) {
    const { rtf, texts } = run(threads);
    const row = { runtime, threads, rtf, wer: wer(texts) };
    results.runs.push(row);
    console.log(`${runtime.padEnd(34)} ${String(threads).padStart(2)} threads: RTF ${rtf.toFixed(4)}, WER ${(row.wer * 100).toFixed(2)}%`);
  }
}
mkdirSync(join(ROOT, 'benchmarks/out'), { recursive: true });
writeFileSync(join(ROOT, `benchmarks/out/${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(results, null, 2));
