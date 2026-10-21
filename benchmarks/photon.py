"""Moondream's Photon (the `moondream` package, its kestrel engine) transcribing recordings on the
CPU with a given number of threads, for `head-to-head.mjs`. Prints one JSON object: the audio
seconds, the compute seconds (after one warm-up recording) and each recording's text.

    python photon.py --threads 8 <recording.wav>...
"""

import argparse
import json
import time
from pathlib import Path

import moondream
import soundfile

parser = argparse.ArgumentParser()
parser.add_argument("--threads", type=int, required=True)
parser.add_argument("recordings", nargs="+")
args = parser.parse_args()

speech = moondream.photon("moondream/parakeet-redux", device="cpu", cpu_threads=args.threads)
speech.transcribe(audio=args.recordings[0])
audio = compute = 0.0
texts = {}
for recording in args.recordings:
    audio += soundfile.info(recording).duration
    start = time.perf_counter()
    texts[Path(recording).stem] = speech.transcribe(audio=recording)["text"]
    compute += time.perf_counter() - start
print(json.dumps({"audio": audio, "compute": compute, "texts": texts}))
