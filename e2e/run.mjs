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

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetched, flags, run, STAMP } from '../vendor/fusor-ai/packages/e2e/kit.mjs';
import { wordErrorRate } from '../scripts/wer.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const values = flags({
  recording: { type: 'string', default: join(ROOT, 'fixtures/recordings/long.wav') },
  'max-wer': { type: 'string', default: '0.12' },
});
const DEADLINE_MS = 10 * 60 * 1000;
// Listening goes on this long past the recording's end, so its last words are heard.
const TAIL_MS = 2000;

const recording = resolve(values.recording);
const reference = JSON.parse(readFileSync(join(dirname(recording), 'references.json'), 'utf8'))[basename(recording, '.wav')];
const recordingMs = (readFileSync(recording).length - 44) / 2 / 16;
const maxWer = Number(values['max-wer']);

// The page's state machine is `main[data-phase]`: idle, starting, listening, transcribing, broken.
const idle = () => /^(idle|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const loadedOrBroken = () => document.querySelector('main')?.dataset.loaded === 'true' || document.querySelector('main')?.dataset.phase === 'broken';

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

const launch = {
  root: ROOT,
  name: 'parakeet',
  values,
  fields: { recording, reference },
  args: ['--autoplay-policy=no-user-gesture-required'],
  init: [playAsMicrophone, readFileSync(recording).toString('base64')],
};
await run(launch, async ({ page, requests, query, base, runDir, results, check, revisit }) => {
  const t0 = Date.now();
  await page.goto(`${base}/${query}`);
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
  results.live.requestsWhileListening = fetched(requests, requestsAtReady);
  check(results.live.status === 'Stopped listening.', `live (Listen pressed while ${results.listenedWhileLoading ? 'loading' : 'loaded'}; ${results.runtime}): RTF ${results.live.rtf}, delay ${results.live.delay}, ${results.live['audio-seconds']} heard`);
  check(results.live.wer.rate <= maxWer, `live WER ${results.live.wer.rate.toFixed(4)} (${results.live.wer.errors}/${results.live.wer.words}, at most ${maxWer})`);
  check(results.live.requestsWhileListening.length === 0 && results.live.requests === '0', `requests while listening: ${results.live.requestsWhileListening.length} seen, page counts ${results.live.requests}`);
  await page.screenshot({ path: join(runDir, `${STAMP}-live.png`), fullPage: true });

  const requestsBeforeFile = requests.length;
  const t1 = Date.now();
  await page.setInputFiles('#file', recording);
  await page.waitForFunction(() => document.querySelector('main')?.dataset.phase !== 'idle', null, { timeout: DEADLINE_MS, polling: 'raf' });
  await page.waitForFunction(idle, null, { timeout: DEADLINE_MS, polling: 250 });
  results.file = await readPage(page);
  results.file.wallMs = Date.now() - t1;
  results.file.wer = wordErrorRate(reference, results.file.text);
  results.file.requests = fetched(requests, requestsBeforeFile);
  check(results.file.status === 'Done.', `file: RTF ${results.file.rtf}, first text after ${results.file.delay}, ${results.file['audio-seconds']} in ${(results.file.wallMs / 1000).toFixed(1)} s`);
  check(results.file.wer.rate <= maxWer, `file WER ${results.file.wer.rate.toFixed(4)} (${results.file.wer.errors}/${results.file.wer.words}, at most ${maxWer})`);
  check(results.file.requests.length === 0, `requests while transcribing the file: ${results.file.requests.length}`);
  await page.screenshot({ path: join(runDir, `${STAMP}-file.png`), fullPage: true });
  writeFileSync(join(runDir, `${STAMP}-live.txt`), `${results.live.text}\n`);
  writeFileSync(join(runDir, `${STAMP}-file.txt`), `${results.file.text}\n`);

  await revisit(loadedOrBroken, DEADLINE_MS);
});
