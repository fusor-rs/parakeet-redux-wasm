// End-to-end run in headless Chrome, in a fresh profile, with a fixed recording as the
// microphone: `getUserMedia` returns a stream that plays it once, in real time. (Chrome's fake
// capture device needs the system's microphone permission on macOS, which a headless run does not
// get; everything after `getUserMedia` is the page's own path.)
//
// 1. Open the page and press Listen while the model is still loading: the audio is kept and
//    transcribed the moment the model is ready. Stop after the recording, then check the live
//    transcript's word error rate against the recording's reference, the delay from audio to
//    text, and that nothing was requested after the model was ready.
// 2. Transcribe the same recording as a file (cut at its pauses, each segment once) and check its
//    word error rate and real-time factor.
// 3. Reload: the revisit must load every part from OPFS.
//
//   PORT=8787 node e2e/run.mjs [--threads 8] [--build web-threaded] [--recording <wav>] [--max-wer 0.12]
//   node e2e/run.mjs --url https://example.org    # a deployed page, no local server
//
// Results (JSON, transcripts, screenshots) go to e2e/results/<timestamp>-*, or to `--out <dir>`.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { wordErrorRate } from '../scripts/wer.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    threads: { type: 'string' },
    build: { type: 'string' },
    recording: { type: 'string', default: join(ROOT, 'fixtures/recordings/long.wav') },
    'max-wer': { type: 'string', default: '0.12' },
    url: { type: 'string' },
    model: { type: 'string' },
    out: { type: 'string' },
  },
});
const PORT = process.env.PORT ?? '8787';
const BASE = (values.url ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const DEADLINE_MS = 10 * 60 * 1000;
// Listening goes on this long past the recording's end, so its last words are heard.
const TAIL_MS = 2000;
const RUN_DIR = values.out ?? join(ROOT, 'e2e/results');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const recording = resolve(values.recording);
const reference = JSON.parse(readFileSync(join(dirname(recording), 'references.json'), 'utf8'))[basename(recording, '.wav')];
const recordingMs = (readFileSync(recording).length - 44) / 2 / 16;
const maxWer = Number(values['max-wer']);

const up = async () => {
  try {
    return (await fetch(`${BASE}/model/manifest.json`)).ok;
  } catch {
    return false;
  }
};
let server = null;
if (!values.url && !(await up())) {
  log(`starting fusor-ai's serve.mjs on :${PORT}`);
  const serve = join(ROOT, 'vendor/fusor-ai/scripts/serve.mjs');
  const mounts = ['--mount', '/=app/dist', '--mount', '/model/=dist/model'];
  server = spawn(process.execPath, [serve, '--port', PORT, ...mounts], { cwd: ROOT, stdio: 'inherit' });
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
}

mkdirSync(RUN_DIR, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'parakeet-e2e-'));
// The page's state machine is `main[data-phase]`: idle, starting, listening, transcribing, broken.
const idle = () => /^(idle|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const loadedOrBroken = () => document.querySelector('main')?.dataset.loaded === 'true' || document.querySelector('main')?.dataset.phase === 'broken';
const results = { started: new Date().toISOString(), base: BASE, recording, reference };
const failures = [];
const check = (ok, message) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

/** In the page: `getUserMedia` resolves to a stream playing the recording (base64 WAV) once. */
function playAsMicrophone(wav) {
  navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext();
    const bytes = Uint8Array.from(atob(wav), (character) => character.charCodeAt(0));
    const source = context.createBufferSource();
    source.buffer = await context.decodeAudioData(bytes.buffer);
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    source.start();
    return destination.stream;
  };
}

/** The transcript and the metric tiles, as the page shows them. */
async function readPage(page) {
  const text = (await page.$$eval('.sentence span', (spans) => spans.map((span) => span.textContent))).join(' ');
  const tiles = ['rtf', 'delay', 'audio-seconds', 'words', 'requests'];
  const shown = await Promise.all(tiles.map((id) => page.textContent(`#${id}`)));
  return { text, status: await page.textContent('#status'), ...Object.fromEntries(tiles.map((id, i) => [id, shown[i]])) };
}

try {
  const context = await chromium.launchPersistentContext(profile, { headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  await context.addInitScript(playAsMicrophone, readFileSync(recording).toString('base64'));
  const requests = [];
  context.on('request', (r) => requests.push(r.url()));
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => m.type() === 'error' && log('console:', m.text()));
  page.on('pageerror', (e) => log('pageerror:', e.message));
  const query = `?${new URLSearchParams(Object.entries({ threads: values.threads, build: values.build, model: values.model }).filter(([, v]) => v))}`;

  const t0 = Date.now();
  await page.goto(`${BASE}/${query}`);
  await page.waitForSelector('main[data-phase]');
  results.listenedWhileLoading = (await page.getAttribute('main', 'data-loaded')) !== 'true';
  await page.click('#listen');
  await page.waitForFunction(loadedOrBroken, null, { timeout: DEADLINE_MS, polling: 250 });
  results.loadMs = Date.now() - t0;
  const requestsAtReady = requests.length;
  await page.waitForTimeout(Math.max(0, recordingMs + TAIL_MS - (Date.now() - t0)));
  await page.click('#stop');
  await page.waitForFunction(idle, null, { timeout: DEADLINE_MS, polling: 250 });
  results.runtime = await page.textContent('#runtime');
  results.live = await readPage(page);
  results.live.wer = wordErrorRate(reference, results.live.text);
  results.live.requestsWhileListening = requests.slice(requestsAtReady).filter((u) => !u.startsWith('blob:'));
  check(results.live.status === 'Stopped listening.', `live (Listen pressed while ${results.listenedWhileLoading ? 'loading' : 'loaded'}; ${results.runtime}): RTF ${results.live.rtf}, delay ${results.live.delay}, ${results.live['audio-seconds']} heard`);
  check(results.live.wer.rate <= maxWer, `live WER ${results.live.wer.rate.toFixed(4)} (${results.live.wer.errors}/${results.live.wer.words}, at most ${maxWer})`);
  check(results.live.requestsWhileListening.length === 0 && results.live.requests === '0', `requests while listening: ${results.live.requestsWhileListening.length} seen, page counts ${results.live.requests}`);
  await page.screenshot({ path: join(RUN_DIR, `${STAMP}-live.png`), fullPage: true });

  const requestsBeforeFile = requests.length;
  const t1 = Date.now();
  await page.setInputFiles('#file', recording);
  await page.waitForFunction(() => document.querySelector('main')?.dataset.phase !== 'idle', null, { timeout: DEADLINE_MS, polling: 'raf' });
  await page.waitForFunction(idle, null, { timeout: DEADLINE_MS, polling: 250 });
  results.file = await readPage(page);
  results.file.wallMs = Date.now() - t1;
  results.file.wer = wordErrorRate(reference, results.file.text);
  results.file.requests = requests.slice(requestsBeforeFile).filter((u) => !u.startsWith('blob:'));
  check(results.file.status === 'Done.', `file: RTF ${results.file.rtf}, first text after ${results.file.delay}, ${results.file['audio-seconds']} in ${(results.file.wallMs / 1000).toFixed(1)} s`);
  check(results.file.wer.rate <= maxWer, `file WER ${results.file.wer.rate.toFixed(4)} (${results.file.wer.errors}/${results.file.wer.words}, at most ${maxWer})`);
  check(results.file.requests.length === 0, `requests while transcribing the file: ${results.file.requests.length}`);
  await page.screenshot({ path: join(RUN_DIR, `${STAMP}-file.png`), fullPage: true });
  writeFileSync(join(RUN_DIR, `${STAMP}-live.txt`), `${results.live.text}\n`);
  writeFileSync(join(RUN_DIR, `${STAMP}-file.txt`), `${results.file.text}\n`);

  const t2 = Date.now();
  await page.reload();
  await page.waitForFunction(loadedOrBroken, null, { timeout: DEADLINE_MS, polling: 250 });
  results.revisitMs = Date.now() - t2;
  results.revisitDetail = await page.textContent('#runtime');
  check(/model loaded from this device/.test(results.revisitDetail), `revisit in ${(results.revisitMs / 1000).toFixed(1)} s: ${results.revisitDetail}`);
  await context.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
  server?.kill();
}

results.failures = failures;
writeFileSync(join(RUN_DIR, `${STAMP}.json`), JSON.stringify(results, null, 2));
log(failures.length ? `e2e FAILED (${failures.length})` : 'e2e passed', `-> ${values.out ?? 'e2e/results'}/${STAMP}.json`);
process.exit(failures.length ? 1 : 0);
