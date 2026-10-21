#!/usr/bin/env bash
# Downloads what `parakeet compile` reads into $1, each file pinned by revision and checked by
# sha256 (files already present are only checked): moondream/parakeet-redux's config, ternary
# manifest, tokenizer and weights.
set -euo pipefail
DIR="$1"
MODEL="https://huggingface.co/moondream/parakeet-redux/resolve/2bf128600aac4b16946f7ed8372e56117fe5e23b"
FILES="
503c653b2e3bb788adbcb04f5abdee532d958686564081baeed133ff10143f6e  config.json
1221c6d3ce901ffe09c089da758a8db8b76189f80cff41c5afc244fc61e2051d  ternary.json
bd321b096832a3f270bd3b2a88823957920f1a5c5ada71114a26ea729d0cbe91  tokenizer.json
78ec25733ee0d0c1586d1346fc86db9d0c2e436e3a8ab1d32a82d1bb8f848d21  model.safetensors
"
mkdir -p "$DIR"
while read -r _ file; do
  if [ -z "$file" ] || [ -s "$DIR/$file" ]; then continue; fi
  echo "downloading $file"
  curl -fsSL --retry 3 -o "$DIR/$file.part" "$MODEL/$file"
  mv "$DIR/$file.part" "$DIR/$file"
done <<< "$FILES"
(cd "$DIR" && awk 'NF { print $1 "  " $2 }' <<< "$FILES" | shasum -a 256 -c --quiet -)
