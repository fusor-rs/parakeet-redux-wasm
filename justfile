# Moondream's Parakeet Redux in the browser. `just ui` builds everything, the model included,
# and serves the page; `just build` then `just serve` do the same in two steps.

import 'vendor/fusor-ai/just/product.just'

name := "parakeet"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/parakeet-redux")
profile := env_var_or_default("PROFILE", "ternary")
model_f32 := "dist/model-f32"
goldens := "fixtures/goldens"
recordings := "fixtures/recordings"
# The reference the goldens come from (vendor/fusor-ai/models/parakeet/reference): Moondream's
# kestrel, pinned.
reference := "uv run --no-project --python 3.12 --with kestrel==0.9.1 --with torch==2.14.1 --with numpy==2.5.4 --with safetensors==0.8.0 --with soundfile==0.14.0 python"

host:
    bash -n scripts/fetch-checkpoint.sh
    python3 -m py_compile scripts/recordings.py benchmarks/photon.py
    node --check app/web/app.js
    node --check app/web/waveform.js
    node --check app/engine/worker.js
    node --check app/engine/capture.js
    node --check scripts/node-smoke.mjs
    node --check scripts/wer.mjs
    node --check e2e/run.mjs
    node --check benchmarks/head-to-head.mjs
    node --check scripts/site-bundle.mjs
    node --check scripts/render-images.mjs

# Downloads the pinned checkpoint (180 MB, sha256-checked) unless it is already there, then
# compiles the bundle (seconds).
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/parakeet compile {{checkpoint}} {{model}} --profile {{profile}}

# Try it on localhost. The bundle and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# The fixed recordings the checks transcribe: LibriSpeech utterances at a pinned revision
# (sha256-checked), as 16 kHz WAV files with their reference transcripts.
recordings:
    test -f {{recordings}}/references.json || uv run --no-project --python 3.12 --with pyarrow==26.0.0 --with soundfile==0.14.0 python scripts/recordings.py {{recordings}}

# Every stage against the reference's goldens (vendor/fusor-ai/models/parakeet/reference), with the
# f32 bundle.
parity: native
    test -f {{goldens}}/golden_f32_A.safetensors || just goldens
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model_f32}}
    target/release/parakeet compile {{checkpoint}} {{model_f32}} --profile f32
    target/release/parakeet parity {{model_f32}} {{goldens}}/golden_f32_A.safetensors

# Golden tensors from the reference runtime (Moondream's kestrel 0.9.1) on one recording.
goldens: recordings
    scripts/fetch-checkpoint.sh {{checkpoint}}
    mkdir -p {{goldens}}
    {{reference}} {{fusor_ai}}/models/parakeet/reference/dump.py {{checkpoint}} {{recordings}}/02.wav {{goldens}}/golden_f32_A.safetensors

bench: native recordings
    target/release/parakeet bench {{model}} {{recordings}}/02.wav

# Native speed and word error rate against Moondream's Photon on the fixed recordings, with the
# same thread counts (benchmarks/head-to-head.mjs).
head-to-head: native recordings
    node benchmarks/head-to-head.mjs

# The page and the bundle beside it, as one static site in target/site, the bundle's tensor parts
# named by their BLAKE3 (`vercel.json` caches them as immutable).
site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    node scripts/site-bundle.mjs {{model}} target/site/model

# The site to Vercel as prebuilt files (`vercel.json`): `production` or `preview`.
deploy environment="production":
    @case "{{environment}}" in production|preview) ;; *) echo "deploy: expected production or preview, got {{environment}}" >&2; exit 2 ;; esac
    vercel build {{ if environment == "production" { "--prod" } else { "" } }} --yes
    vercel deploy --prebuilt {{ if environment == "production" { "--prod" } else { "" } }} --yes

# The site to the Hugging Face Space fusorlabs/parakeet-redux-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/README.md target/site/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site <<'EOF'
    import sys
    from huggingface_hub import HfApi

    HfApi().upload_folder(
        repo_id="fusorlabs/parakeet-redux-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy parakeet-redux-wasm {{version}}",
    )
    EOF

# The fixed inputs the checks read.
fixtures: recordings
