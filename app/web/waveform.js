// The waveform: peaks as bars across the full width, regrouped as more arrive, colored up to the
// share of the audio already transcribed. Live audio shows only its last `span` peaks, scrolling.
// Draws at most once per animation frame.

const BAR_PX = 2;
const GAP_PX = 1;
// Loudness reads better on a compressed scale than on raw peaks.
const LOUDNESS_EXPONENT = 0.6;

export class Waveform {
  #root;
  #peaks = [];
  #span = Infinity;
  #played = 0;
  #pending = false;

  constructor(root) {
    this.#root = root;
  }

  /** Forgets the peaks; `span` is how many of the latest to show (all by default). */
  reset(span = Infinity) {
    this.#peaks = [];
    this.#span = span;
    this.#played = span === Infinity ? 0 : 1;
    this.#invalidate();
  }

  push(peaks) {
    this.#peaks.push(...peaks);
    this.#invalidate();
  }

  /** `fraction` of the audio is transcribed. */
  play(fraction) {
    this.#played = Math.min(1, fraction);
    this.#invalidate();
  }

  #invalidate() {
    if (this.#pending) return;
    this.#pending = true;
    requestAnimationFrame(() => {
      this.#pending = false;
      this.#draw();
    });
  }

  #draw() {
    const canvas = this.#root.querySelector('#wave');
    if (!canvas) return;
    const scale = devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    const style = getComputedStyle(canvas);
    const peaks = this.#peaks.slice(-this.#span);
    const slots = Math.floor(width / (BAR_PX + GAP_PX));
    const perColumn = Math.max(1, Math.ceil(peaks.length / slots));
    const columns = this.#span === Infinity ? Math.ceil(peaks.length / perColumn) : slots;
    const step = width / Math.max(1, columns);
    const bar = Math.max(BAR_PX, step - GAP_PX);
    for (let column = 0; column < columns; column++) {
      const bins = peaks.slice(column * perColumn, (column + 1) * perColumn);
      const level = Math.max(0, ...bins) ** LOUDNESS_EXPONENT;
      const length = Math.max(BAR_PX, level * height);
      context.fillStyle = column < columns * this.#played ? style.getPropertyValue('--accent') : style.getPropertyValue('--ink-faint');
      context.beginPath();
      context.roundRect(column * step, (height - length) / 2, bar, length, Math.min(bar, length) / 2);
      context.fill();
    }
  }
}
