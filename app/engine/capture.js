// The audio worklet that captures the microphone: its context runs at the model's 16 kHz (the
// browser resamples the device to it), and the render thread posts the audio, its channels
// averaged, straight to the engine worker in pieces of `PIECE_SECONDS` through the MessagePort the
// page hands it for each listening session (`engine`). The page hears the loudness of each
// `PEAK_SECONDS`, for its waveform. The node's output stays silent.

const PIECE_SECONDS = 0.1;
const PEAK_SECONDS = 0.05;
const PIECE_SAMPLES = Math.round(PIECE_SECONDS * sampleRate);
const PEAK_SAMPLES = Math.round(PEAK_SECONDS * sampleRate);

class Capture extends AudioWorkletProcessor {
  #engine = null;
  #piece = new Float32Array(PIECE_SAMPLES);
  #filled = 0;
  #peaks = [];
  #peak = 0;
  #peakFilled = 0;

  constructor() {
    super();
    // A new port is a new listening session: it starts with an empty piece.
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'engine') return;
      this.#engine = data.port;
      this.#filled = 0;
    };
  }

  process([channels]) {
    if (!channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.#take(sample);
    }
    return true;
  }

  #take(sample) {
    this.#piece[this.#filled++] = sample;
    if (this.#filled === PIECE_SAMPLES) {
      // Transferring the piece detaches it: the next one is new.
      this.#engine?.postMessage(this.#piece, [this.#piece.buffer]);
      this.#piece = new Float32Array(PIECE_SAMPLES);
      this.#filled = 0;
    }
    this.#peak = Math.max(this.#peak, Math.abs(sample));
    if (++this.#peakFilled === PEAK_SAMPLES) {
      this.#peaks.push(this.#peak);
      this.#peak = 0;
      this.#peakFilled = 0;
    }
    if (this.#peaks.length && this.#filled === 0) this.port.postMessage({ peaks: this.#peaks.splice(0) });
  }
}

registerProcessor('parakeet-capture', Capture);
