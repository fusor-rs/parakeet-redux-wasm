"""The fixed recordings the checks transcribe, into the directory given: the 73 LibriSpeech
dev-clean utterances of hf-internal-testing/librispeech_asr_dummy (CC-BY-4.0) at a pinned
revision, checked by sha256, as 16 kHz 16-bit WAV files `00.wav` … `72.wav`, and `long.wav`, the
first ten joined by `GAP_SECONDS` of silence (longer than a segment, so it is cut at pauses).
`references.json` maps each name to its reference transcript.

    python recordings.py <out dir>
"""

import hashlib
import io
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile

URL = (
    "https://huggingface.co/datasets/hf-internal-testing/librispeech_asr_dummy/resolve/"
    "5be91486e11a2d616f4ec5db8d3fd248585ac07a/clean/validation-00000-of-00001.parquet"
)
SHA256 = "4e69a06fa5edc90921e5e7e39a7084881f8b3ed9c805c574f4f39c6fde27c603"
SAMPLE_RATE = 16_000
LONG_UTTERANCES = 10
GAP_SECONDS = 0.6

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
data = urllib.request.urlopen(URL).read()
digest = hashlib.sha256(data).hexdigest()
if digest != SHA256:
    sys.exit(f"{URL}: sha256 {digest}, expected {SHA256}")

references = {}
long_audio = []
for index, row in enumerate(pq.read_table(io.BytesIO(data)).to_pylist()):
    pcm, rate = soundfile.read(io.BytesIO(row["audio"]["bytes"]), dtype="float32")
    if rate != SAMPLE_RATE or pcm.ndim != 1:
        sys.exit(f"{row['id']}: {rate} Hz, {pcm.ndim} dimensions; 16 kHz mono expected")
    name = f"{index:02d}"
    soundfile.write(out / f"{name}.wav", pcm, SAMPLE_RATE, subtype="PCM_16")
    references[name] = row["text"]
    if index < LONG_UTTERANCES:
        long_audio += [pcm, np.zeros(round(GAP_SECONDS * SAMPLE_RATE), dtype=np.float32)]

soundfile.write(out / "long.wav", np.concatenate(long_audio), SAMPLE_RATE, subtype="PCM_16")
references["long"] = " ".join(references[f"{index:02d}"] for index in range(LONG_UTTERANCES))
(out / "references.json").write_text(json.dumps(references, indent=1) + "\n")
print(f"{len(references) - 1} recordings and long.wav -> {out}")
