//! `parakeet`: the native host of the runtime.
//!
//! - `compile`: checkpoint → bundle (the `parakeet-compile` crate).
//! - `transcribe`: 16 kHz WAV files → timed sentences, printing the real-time factor.
//! - `parity`: every stage against the reference goldens.
//! - `bench`: milliseconds per second of audio of each stage.

mod bench;
mod parity;

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, ensure};
use bundle::{Engine as _, Manifest, Store};
use clap::{Parser, Subcommand};
use parakeet::SAMPLE_RATE;
use parakeet::session::Engine;

#[derive(Parser)]
#[command(name = "parakeet", version)]
struct Cli {
    /// Compute threads (default: min(8, cores − 2)).
    #[arg(long, global = true)]
    threads: Option<usize>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Compile the checkpoint directory (config.json, ternary.json, tokenizer.json and
    /// model.safetensors, as scripts/fetch-checkpoint.sh downloads them) into a bundle.
    Compile {
        checkpoint: PathBuf,
        out: PathBuf,
        #[arg(long, default_value = "ternary")]
        profile: parakeet_compile::Profile,
    },
    /// Transcribe WAV files (16 kHz; channels are averaged), each under a `# <file>` line.
    Transcribe {
        bundle: PathBuf,
        #[arg(required = true)]
        recordings: Vec<PathBuf>,
    },
    /// Compare every stage with the golden tensors of the reference.
    Parity { bundle: PathBuf, goldens: PathBuf },
    /// Time each stage on a WAV file (16 kHz, at most 30 s).
    Bench { bundle: PathBuf, recording: PathBuf },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cores = std::thread::available_parallelism().map_or(4, std::num::NonZero::get);
    let threads = cli.threads.unwrap_or(8.min(cores.saturating_sub(2)).max(1));
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build_global()?;
    match cli.command {
        Command::Compile {
            checkpoint,
            out,
            profile,
        } => compile(&checkpoint, &out, profile)?,
        Command::Transcribe { bundle, recordings } => {
            transcribe(&mut load(&bundle)?, &recordings)?;
        }
        Command::Parity { bundle, goldens } => parity::run(&mut load(&bundle)?, &goldens)?,
        Command::Bench { bundle, recording } => {
            bench::run(&mut load(&bundle)?, &read(&recording)?)?
        }
    }
    Ok(())
}

fn compile(checkpoint: &Path, out: &Path, profile: parakeet_compile::Profile) -> Result<()> {
    let start = Instant::now();
    let manifest = parakeet_compile::run(checkpoint, out, profile)?;
    let mb = manifest.parts.iter().map(|part| part.bytes).sum::<u64>() as f64 / 1e6;
    println!(
        "{} tensors, {} parts, {mb:.1} MB in {:.1}s",
        manifest.tensors.len(),
        manifest.parts.len(),
        start.elapsed().as_secs_f64()
    );
    Ok(())
}

// Loads a bundle directory the way the browser does: every part pushed in order, then hashed.
pub fn load(dir: &Path) -> Result<Engine> {
    let start = Instant::now();
    let manifest = Manifest::parse(&std::fs::read_to_string(dir.join("manifest.json"))?)?;
    let mut store = Store::new(manifest.clone())?;
    for (index, part) in manifest.parts.iter().enumerate() {
        let bytes = std::fs::read(dir.join(&part.file)).with_context(|| part.file.clone())?;
        for chunk in bytes.chunks(8 << 20) {
            store.write(index, chunk)?;
        }
        store.end_part(index)?;
    }
    let engine = Engine::new(&mut store)?;
    eprintln!(
        "loaded {} ({:.0} MB) in {:.2}s, {} threads",
        dir.display(),
        manifest.tensor_bytes() as f64 / 1e6,
        start.elapsed().as_secs_f64(),
        engine.threads()
    );
    Ok(engine)
}

/// The samples of a 16 kHz WAV file, channels averaged.
fn read(path: &Path) -> Result<Vec<f32>> {
    let bytes = std::fs::read(path).with_context(|| path.display().to_string())?;
    let (samples, rate) = parakeet::wav::decode(&bytes)?;
    ensure!(
        rate == SAMPLE_RATE,
        "{}: {rate} Hz; resample it to {SAMPLE_RATE} Hz (ffmpeg -ar {SAMPLE_RATE})",
        path.display()
    );
    Ok(samples)
}

fn transcribe(engine: &mut Engine, recordings: &[PathBuf]) -> Result<()> {
    let (mut audio, mut compute, mut segments) = (0.0, 0.0, 0);
    for recording in recordings {
        let pcm = read(recording)?;
        println!("# {}", recording.display());
        let start = Instant::now();
        let plan = engine.start(pcm)?;
        loop {
            let progress = engine.step()?;
            for sentence in &progress.sentences {
                println!(
                    "[{:7.2} – {:7.2}] {}",
                    sentence.start, sentence.end, sentence.text
                );
            }
            if progress.done {
                break;
            }
        }
        compute += start.elapsed().as_secs_f64();
        audio += plan.seconds;
        segments += plan.segments.len();
    }
    eprintln!(
        "{audio:.2}s of audio in {} recording(s), {segments} segment(s), {compute:.2}s: RTF {:.4}",
        recordings.len(),
        compute / audio
    );
    Ok(())
}
