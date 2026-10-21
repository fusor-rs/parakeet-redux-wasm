---
title: parakeet-redux-wasm
short_description: Moondream Parakeet Redux speech to text in the browser
sdk: static
app_file: index.html
pinned: false
license: mit
models:
  - moondream/parakeet-redux
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

Speech to text with [Moondream Parakeet Redux](https://huggingface.co/moondream/parakeet-redux),
based on NVIDIA's [parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
(CC-BY-4.0), computed on your own CPU in the browser: the model, compiled to WebAssembly with
fusor-ai, downloads once and then runs sealed from the network, transcribing as you speak or a
recording you pick. The source is
[github.com/fusor-rs/parakeet-redux-wasm](https://github.com/fusor-rs/parakeet-redux-wasm).
