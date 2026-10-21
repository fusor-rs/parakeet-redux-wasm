# Benchmarks

How fast Moondream Parakeet Redux transcribes on one machine, and how well: this repository's parakeet-redux-wasm (the page in Chrome, the single-threaded builds in Node, the native `parakeet` CLI) and, natively, Moondream's own runtime of the same model, [Photon](https://moondream.ai/photon) (the `moondream` package 2.6.1 and its kestrel engine). Photon has no browser build, so in the browser there is nothing of it to compare. Everything here was measured on 2026-10-21 on the machine below, by the checks and scripts in this repository; nothing is quoted from elsewhere.

**Real-time factor (RTF)** is compute time divided by the duration of the audio: 0.05 means a second of speech took 50 ms to transcribe, and anything below 1 is faster than real time. Moondream's model card quotes the inverse, seconds of audio per second. Beside RTF: the **delay** from audio to its text while listening, the **word error rate (WER)** against the recordings' LibriSpeech references (`scripts/wer.mjs`: lowercase, punctuation dropped, `mr`, `mrs` and `dr` spelled out), the **download**, and the **agreement** of every stage with Moondream's engine.

The recordings are `fixtures/recordings` (`just recordings`): the 73 LibriSpeech dev-clean utterances of `hf-internal-testing/librispeech_asr_dummy` (CC-BY-4.0), 481 s in all, and `long.wav`, the first ten joined by 0.6 s of silence (116 s, 254 words, longer than a segment, so it is cut at its pauses). Each number is one run.

## Headline

| Runtime | Threads | RTF | Delay while listening | WER |
|---|---:|---:|---:|---:|
| **Chrome, the 116 s recording** | | | | |
| parakeet-redux-wasm `web-threaded-relaxed`, file | 8 | **0.024** | – | 4.72% |
| parakeet-redux-wasm `web-threaded-relaxed`, listening | 8 | 0.310 ¹ | **0.15 s** | 5.91% |
| parakeet-redux-wasm `web-single-relaxed`, file | 1 | 0.141 | – | 4.72% |
| parakeet-redux-wasm `web-single-relaxed`, listening | 1 | 0.991 ¹ | 0.70 s | 5.12% |
| **native, all 74 recordings** | | | | |
| `parakeet transcribe` (parakeet-redux-wasm) | 1 | 0.096 | – | 4.49% |
| Photon | 1 | **0.063** | – | **4.27%** |
| `parakeet transcribe` | 8 | 0.045 | – | 4.49% |
| Photon | 8 | **0.021** | – | **4.27%** |

¹ Listening re-reads the audio that is not final yet whenever half a second more has arrived, so its compute is several times a file's; what matters is that it keeps up (the delay).

## Machine and software

| | |
|---|---|
| CPU | Apple M4 Pro, 14 cores (10 performance, 4 efficiency), 24 GB |
| Browser | Playwright 1.64.1's Chromium headless shell, through `e2e/run.mjs` |
| Node.js | 22.16.0 |
| parakeet-redux-wasm | fusor-ai 0.1.2 (Chrome on 8 threads, Node, parity); fusor-ai `0b0144f`, the commit before the 0.1.2 audit (Chrome on 1 thread, native) |
| Photon | `moondream` 2.6.1, kestrel 0.9.1, on the CPU (`cpu_threads`); its int8 kernel here is `neon-dotprod` |

Other work kept the machine busy during the native runs (a load average of 13 on 14 cores). Our thread team spins at its barriers, so a core taken away stalls every thread; the eight-thread native numbers are the most affected.

## In the browser

`just e2e` presses **Listen** while the model is still loading, with `long.wav` as the microphone (played in real time into `getUserMedia`), stops after it, then transcribes the same recording as a file, and reloads the page.

| Build | Threads | File: time, RTF | First text | Listening: delay | Audio heard | WER file / listening | Revisit |
|---|---:|---:|---:|---:|---:|---:|---:|
| `web-threaded-relaxed` | 8 | 3.0 s, 0.024 | 0.69 s | 0.15 s | 117.0 s | 4.72% / 5.91% | 0.3 s |
| `web-single-relaxed` | 1 | 16.6 s, 0.141 | 4.10 s | 0.70 s | 116.8 s | 4.72% / 5.12% | 0.6 s |

The file's segments are the same in every build; the live segments are cut where the pauses are when the audio arrives, so the live word error rate moves between runs (5.1–5.9% so far). The page made no network request after the model was ready in any run.

## In Node

`just smoke` runs the single-threaded builds on `long.wav`, as a file and as live audio heard in 0.5 s pieces with an update after each (as fast as it can, not paced to real time).

| Build | File RTF | File WER | Live RTF | Live WER |
|---|---:|---:|---:|---:|
| `web-single-relaxed` (relaxed SIMD) | 0.177 | 5.51% | 1.54 | 5.12% |
| `web-single` (SIMD128) | 0.305 | 5.12% | 2.75 | 5.12% |

## Natively, against Photon

`just head-to-head` runs `parakeet transcribe` and Photon (`benchmarks/photon.py`) over all 74 recordings with the same thread counts, the RTF over the whole set and the WER over all its words.

| Runtime | Weights | Threads | RTF | WER |
|---|---|---:|---:|---:|
| `parakeet transcribe` | ternary (`T2b128`), 7-bit elsewhere | 1 | 0.096 | 4.49% |
| Photon | ternary, 2-bit in memory | 1 | **0.063** | **4.27%** |
| `parakeet transcribe` | ternary, 7-bit elsewhere | 8 | 0.045 | 4.49% |
| Photon | ternary, 2-bit in memory | 8 | **0.021** | **4.27%** |

Photon is faster natively: both multiply with the CPU's `sdot`, and its native kernels get more out of it than ours, which are built for WebAssembly first. The transcripts differ in a handful of borderline words (*upguards* against *up guards*), where rounding in the encoder tips them; on the 73 single utterances, kestrel's own CPU path and ours give the same text for every one.

## Agreement

`just parity` runs every stage, teacher-forced, against goldens from kestrel 0.9.1 with its ternary weights expanded to f32 (`scripts/golden-harness`), on utterance `02` (12.5 s):

| Stage | Relative L2 |
|---|---:|
| Features | 3.77e-6 |
| Subsampling | 8.39e-7 |
| Speech head | 3.28e-8 |
| Encoder (through the joint's projection) | 1.29e-6 |
| Decoder | 87 of 87 decisions identical (61 tokens) |

## Download

| | Bytes |
|---|---:|
| parakeet-redux-wasm's bundle (`dist/model`): the encoder in 2-bit codes, the rest in 7 bits | 198.8 MB |
| The checkpoint Photon reads (`model.safetensors`): the encoder in 1.6-bit base-3 codes, the rest in f16 | 177.8 MB |
| One runtime build (`web-threaded-relaxed`) | 0.86 MB |

## Reproducing

```sh
just recordings
just e2e                    # the page in Chrome; node e2e/run.mjs --threads 1 for one thread
just smoke                  # Node
just head-to-head           # native, against Photon (uv fetches moondream 2.6.1)
just parity                 # every stage against kestrel's goldens
```
