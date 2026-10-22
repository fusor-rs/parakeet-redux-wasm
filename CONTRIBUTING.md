# Contributing

Use Rust 1.99 or later, edition 2024, Node.js 22 or later, `just`, and
[uv](https://docs.astral.sh/uv/) for the Python helpers (the fixed recordings, the goldens and
the head-to-head). Clone with `--recurse-submodules` (or run `just tools`, which initializes
`vendor/fusor-ai`). `unsafe` is denied (see `AGENTS.md`).

The model, its compiler and the toolkit live in
[fusor-ai](https://github.com/fusor-rs/fusor-ai). Everything this repository takes from it
comes from `vendor/fusor-ai`, a submodule pinned to a commit pushed to fusor-ai: the
`fusor-ai-*` crates, as path dependencies in the root `Cargo.toml`, the browser host scripts,
the runtime build and the import check. To move to another fusor-ai commit, check it out in the
submodule (`git -C vendor/fusor-ai checkout <commit>`) in one change of its own, with the
checks below. Never add a crates.io pin, a `[patch]` table or a path to a fusor-ai checkout
beside this one.

Run `just check` before considering a change complete. It formats, tests and lints the crates
natively, the runtime for `wasm32-unknown-unknown` (SIMD128 and relaxed SIMD) and the page,
and syntax-checks the scripts. `just ui` builds the page and serves it; the page is a
[fusor](https://github.com/fusor-rs/fusor) app in `app/`, built with the fusor CLI that
`just tools` installs into `.tools/`. A change to the runtime, the page, the CLI or fusor-ai
also needs `just build` once, then `just runtimes`, `just smoke`, `just parity` and
`just e2e`, and a change meant to move speed `just head-to-head`. Say in the pull request what
they showed (parity numbers, real-time factor, delay, word error rate) and which fusor-ai commit
they ran against.

`just recordings` downloads the fixed recordings the checks transcribe: the 73 LibriSpeech
dev-clean utterances of `hf-internal-testing/librispeech_asr_dummy` at a pinned revision
(sha256-checked), as 16 kHz WAV files, and `long.wav`, the first ten joined by short silences
(longer than a segment, so it is cut at pauses).

`just parity` compares every stage with goldens from the reference runtime, Moondream's kestrel
(the engine behind Photon) at version 0.9.1 with its ternary weights expanded to f32, which
`just goldens` makes with `scripts/golden-harness`; `just parity` runs it first when the goldens
are missing. Parity uses the f32 bundle (`PROFILE=f32`, 2.5 GB, native only).

`just smoke` runs the single-threaded runtimes in Node on `long.wav`, as a file and as live
audio, and prints the real-time factor and the word error rate of each. `just e2e` runs the page
in headless Chrome: it presses Listen while the model loads, with `long.wav` as the microphone,
then transcribes the same recording as a file, and reloads; the word error rate on that
recording must not rise. `getUserMedia` is the one thing the run replaces: Chrome's fake capture
device needs the system's microphone permission on macOS, which a headless run does not get.

The threaded runtimes need `nightly-2025-11-15` with `rust-src`; `just tools` installs it,
and fusor-ai's `scripts/install-tools.sh` the pinned wasm-bindgen and binaryen into `.tools/`.

## The README's images

`assets/brand/banner.html` and `assets/benchmarks/benchmarks.html` are the README's banner and
benchmark summary, and `assets/social/speed.html` the image for posts;
`node scripts/render-images.mjs` renders each into a light and a dark PNG next to it, with the
e2e's Playwright (`cd e2e && npm ci` first). The benchmark and post pages' numbers come from
`benchmarks.md`: change them together.

## Deploying the site

`just site` puts the page, its four runtimes and the bundle beside it into `target/site`, a
static site that must be served cross-origin isolated to get the threaded runtimes. The bundle's
tensor parts are named by their BLAKE3 there, so caching `/model/parts/` as immutable stays
correct across recompiles, and the page deletes the parts of earlier bundles from its OPFS cache
after loading a new one.
[vercel.json](vercel.json) does that for Vercel (`just deploy`, prebuilt files, after
`vercel link`), and [space/README.md](space/README.md) for a static Hugging Face Space
(`just deploy-space`, with [uv](https://docs.astral.sh/uv/) after `hf auth login`).

## Using AI tools

You're welcome to use AI tools, but you're responsible for everything you submit. Read and
understand every line, make sure the tests you add would fail without your change, and be ready
to explain your reasoning in review. Please don't open pull requests or issues generated
without that review.

Coding agents follow `AGENTS.md`, which is also the code standard for every change.
