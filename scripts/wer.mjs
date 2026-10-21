// Word error rate of a transcript against its reference, both normalized the same way:
// lowercase, hyphens as spaces, punctuation dropped (apostrophes kept), the honorifics the model
// abbreviates spelled out as LibriSpeech references spell them.
//
//   node scripts/wer.mjs "<reference>" "<transcript>"

const SPELLED = { mr: 'mister', mrs: 'missus', dr: 'doctor' };

export function words(text) {
  const plain = text.toLowerCase().replace(/-/g, ' ').replace(/[^\p{L}\p{N}' ]/gu, ' ');
  return plain.split(/\s+/).filter(Boolean).map((word) => SPELLED[word] ?? word);
}

/** `{ errors, words, rate }`: substitutions, deletions and insertions over the reference's words. */
export function wordErrorRate(reference, transcript) {
  const [want, got] = [words(reference), words(transcript)];
  let previous = Array.from({ length: got.length + 1 }, (_, j) => j);
  for (let i = 1; i <= want.length; i++) {
    const row = [i];
    for (let j = 1; j <= got.length; j++) {
      const substitution = previous[j - 1] + (want[i - 1] === got[j - 1] ? 0 : 1);
      row.push(Math.min(substitution, previous[j] + 1, row[j - 1] + 1));
    }
    previous = row;
  }
  const errors = previous[got.length];
  return { errors, words: want.length, rate: errors / Math.max(1, want.length) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { errors, words: count, rate } = wordErrorRate(process.argv[2] ?? '', process.argv[3] ?? '');
  console.log(`WER=${rate.toFixed(4)} (${errors} errors in ${count} words)`);
}
