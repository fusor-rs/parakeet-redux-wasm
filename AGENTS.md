# AGENTS.md

Rules for coding agents in this repository that are its own. fusor-ai's
`vendor/fusor-ai/AGENTS.md` is the standard and binds here too (`CLAUDE.md`
imports both); this file adds what is particular to this product.

parakeet-redux-wasm is the Moondream Parakeet Redux (moondream/parakeet-redux)
speech-to-text app: the model, a 1.58-bit version of NVIDIA's
parakeet-tdt-0.6b-v3 for 25 languages, running in the browser on the CPU,
sealed from the network, transcribing audio from the microphone or a file. The
README describes what it does; don't invent scope, features or options beyond
the task.

## Repository

- `vendor/fusor-ai/models/parakeet/runtime`: the wasm-bindgen surface of the
  model (bundle parts and 16 kHz PCM in, text and timestamps out), built as four
  browser runtimes.
- `vendor/fusor-ai/models/parakeet/cli`: the native CLI `parakeet` (`compile`,
  `transcribe`, `bench`, `parity`).
- `app/`: the page, a [fusor](https://github.com/fusor-rs/fusor) app with its own
  Cargo workspace (fusor pins wasm-bindgen 0.2.117, the runtime 0.2.129): the
  form, the loading and the live measurements as Rust signals in `src/app.rs`,
  the template in `web/index.html`, the engine bridge and the waveform in
  `web/*.js`, and in `engine/` the engine worker and the capture worklet that
  feeds it, beside the runtimes `just runtimes` builds.
- `scripts/`: the checkpoint download (pinned to a revision, sha256-checked),
  the Node smoke test and the word error rate check; `e2e/run.mjs`: the headless
  Chrome run; `benchmarks/`: the comparisons with other Parakeet runtimes.
- [fusor-ai](https://github.com/fusor-rs/fusor-ai): the model (`parakeet`), its
  compiler (`parakeet-compile`), the kernels, blocks and bundle format come from
  `vendor/fusor-ai`, a git submodule pinned to a commit pushed to fusor-ai, with
  the browser loader and compute pool, the runtime build, the import check and
  the dev server.

What belongs where: model code (dimensions, tensor names, wiring, the audio
frontend, the decoder and its vocabulary) and anything another model could reuse
go to fusor-ai, following its `AGENTS.md`. This repository holds what turns the
model into an app: the page, the checks against the reference and the
deployment. A change to fusor-ai lands there first; this repository never
patches it.

Constraints that hold everywhere:

- fusor-ai comes only from `vendor/fusor-ai`, never a crates.io version, a
  `[patch]` table or a sibling checkout. The submodule moves to another pushed
  fusor-ai commit in a change of its own, with the parity numbers and the e2e
  result it gave. No copies of fusor-ai code here.
- The page owns every capability: the microphone, decoding audio files and
  resampling them to 16 kHz, caching the bundle (OPFS) and measuring itself. The
  runtime receives PCM and does no I/O. Microphone audio goes from the capture
  worklet to the engine worker directly, so the page's main thread only draws.
- RTF here is compute time over audio time: lower is faster, as in the other
  fusor-ai apps. Moondream's model card quotes the inverse (seconds of audio per
  second, higher is faster); convert before comparing, and say which one a
  number is.
- The model is CC-BY-4.0: the page, the README and the Space credit Moondream
  and NVIDIA's parakeet-tdt-0.6b-v3, with links.

## Checks

A change is done only when this passes:

```sh
just check
```

It runs formatting and Clippy on the page and syntax checks of the scripts;
fusor-ai's `just check` covers the runtime and the CLI. A change to the runtime,
the page, the CLI or fusor-ai also needs `just runtimes`, `just smoke`, `just
parity` (the same numbers as before unless the change is meant to move them) and
`just e2e`, whose word error rate on its fixed recordings must not rise; a
change meant to move speed also needs `just head-to-head`. The model is checked
stage by stage against the reference goldens by `parakeet parity`; extend it
rather than adding a parallel harness.

## Commits

- Don't commit, push, tag, release or deploy unless asked. Deploying is
  described in `CONTRIBUTING.md` and is done by the maintainer.
- Git runs as `andreespirela` here: the local config pins the author, the
  credential user and the remote URL, as in the other fusor repositories. Don't
  change it, and clone fusor repositories with
  `https://andreespirela@github.com/fusor-rs/<name>.git`.
