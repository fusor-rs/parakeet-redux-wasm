//! `parakeet bench`: milliseconds of each stage on one recording of at most a segment, per
//! second of its audio, and the real-time factor of recognizing it whole.

use std::time::Instant;

use anyhow::Result;
use parakeet::SAMPLE_RATE;
use parakeet::pipeline::Stage;
use parakeet::session::Engine;

const CALLS: usize = 5;

/// Milliseconds per call of `call`, after one warm-up call.
fn time<T>(mut call: impl FnMut() -> Result<T, parakeet::Error>) -> Result<f64, parakeet::Error> {
    call()?;
    let start = Instant::now();
    for _ in 0..CALLS {
        call()?;
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0 / CALLS as f64)
}

pub fn run(engine: &mut Engine, pcm: &[f32]) -> Result<()> {
    let seconds = pcm.len() as f64 / f64::from(SAMPLE_RATE);
    println!("threads {}, {seconds:.2}s of audio", engine.threads());
    let features = engine.features(pcm)?;
    let encoded = engine.encode(&features)?;
    for stage in Stage::ALL {
        let ms = match stage {
            Stage::Features => time(|| engine.features(pcm))?,
            Stage::Subsampling => time(|| engine.subsample(&features))?,
            Stage::Speech => time(|| engine.speech(&features))?,
            Stage::Encoder => time(|| engine.encode(&features))?,
            Stage::Decoder => time(|| engine.decode(&encoded))?,
        };
        println!(
            "  {:12} {ms:8.1} ms, {:6.2} ms per second of audio",
            stage.name(),
            ms / seconds
        );
    }
    let ms = time(|| engine.recognize(pcm))?;
    println!(
        "  recognize    {ms:8.1} ms → RTF {:.4} ({:.0}× faster than real time)",
        ms / 1000.0 / seconds,
        seconds * 1000.0 / ms
    );
    Ok(())
}
