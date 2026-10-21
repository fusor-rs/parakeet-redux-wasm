use fusor::{JsInputs, Signal, signal};
use serde::Deserialize;

const SECONDS_PER_MINUTE: u64 = 60;
const MINUTES_PER_HOUR: u64 = 60;

/// A transcribed stretch of speech, `parakeet::vocabulary::Timed`.
#[derive(Clone, PartialEq, Deserialize)]
struct Timed {
    text: String,
    start: f64,
    end: f64,
}

/// A sentence as the page lists it: `id` orders and keys it.
#[derive(Clone, PartialEq)]
struct Line {
    id: u32,
    sentence: Timed,
}

impl Line {
    fn time(&self) -> String {
        clock(self.sentence.start)
    }

    fn span(&self) -> String {
        format!(
            "{} to {}",
            clock(self.sentence.start),
            clock(self.sentence.end)
        )
    }
}

// The runtime build and the bundle, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part came from this device's storage.
    from_device: bool,
}

impl Loaded {
    fn summary(&self) -> String {
        let threads = match self.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        let source = if self.from_device {
            "model loaded from this device"
        } else {
            "model downloaded"
        };
        format!(
            "{} · {threads} · {:.1} MB bundle · {source} in {:.1} s",
            self.build,
            self.bundle_bytes / 1e6,
            self.load_ms / 1000.0
        )
    }
}

/// What `web/app.js` measures, live while audio is transcribed: the audio read so far, the
/// engine's time inside the runtime (`compute_ms`), the delay from audio to its text
/// (`delay_ms`: listening, the mean from the newest audio of an update to its text; for a file,
/// from choosing it to its first text) and the network requests made since the model loaded.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Metrics {
    audio_seconds: f64,
    compute_ms: f64,
    delay_ms: Option<f64>,
    requests: u32,
}

impl Metrics {
    fn real_time_factor(&self) -> String {
        if self.audio_seconds == 0.0 {
            return "–".into();
        }
        format!("{:.3}", self.compute_ms / 1000.0 / self.audio_seconds)
    }

    fn speedup(&self) -> String {
        if self.compute_ms == 0.0 || self.audio_seconds == 0.0 {
            return "compute over audio time".into();
        }
        format!(
            "{:.0}× faster than real time",
            self.audio_seconds * 1000.0 / self.compute_ms
        )
    }

    fn delay(&self) -> String {
        self.delay_ms
            .map_or("–".into(), |ms| format!("{:.2} s", ms / 1000.0))
    }

    fn audio(&self) -> String {
        format!("{:.1} s", self.audio_seconds)
    }

    fn requests(&self) -> String {
        self.requests.to_string()
    }
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Loading {
        fraction: f64,
        detail: String,
    },
    Ready {
        loaded: Loaded,
    },
    // Listening or transcribing a file started.
    Started {
        phase: Started,
        status: String,
    },
    // New final sentences, and the provisional ones that replace the last.
    Text {
        committed: Vec<Timed>,
        provisional: Vec<Timed>,
        status: String,
        metrics: Metrics,
    },
    Done {
        status: String,
        metrics: Metrics,
    },
    // Something failed; the engine can take the next request.
    Error {
        message: String,
    },
    // The model could not load, or the engine died: nothing more can run in this page.
    Broken {
        message: String,
    },
}

#[derive(Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Started {
    Listening,
    Transcribing,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    // Waiting for the microphone or the file.
    Starting,
    Listening,
    Transcribing,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Listening => "listening",
            Self::Transcribing => "transcribing",
            Self::Broken => "broken",
        }
    }
}

#[derive(JsInputs)]
struct App {
    // `web/app.js` acts on every new count: `listens` (Listen) opens the microphone inside the
    // user's gesture, `files` reads the file chosen in `#file`, `stops` stops either, `copies`
    // copies the transcript.
    #[js]
    listens: Signal<u32>,
    #[js]
    files: Signal<u32>,
    #[js]
    stops: Signal<u32>,
    #[js]
    copies: Signal<u32>,
    phase: Signal<Phase>,
    fraction: Signal<f64>,
    detail: Signal<String>,
    status: Signal<String>,
    lines: Signal<Vec<Line>>,
    provisional: Signal<Vec<Line>>,
    metrics: Signal<Metrics>,
    measured: Signal<bool>,
    loaded: Signal<Option<Loaded>>,
}

impl App {
    fn new() -> Self {
        Self {
            listens: signal(0),
            files: signal(0),
            stops: signal(0),
            copies: signal(0),
            phase: signal(Phase::Idle),
            fraction: signal(0.0),
            detail: signal("Starting…".into()),
            status: signal(String::new()),
            lines: signal(Vec::new()),
            provisional: signal(Vec::new()),
            metrics: signal(Metrics::default()),
            measured: signal(false),
            loaded: signal(None),
        }
    }

    fn listen(&self) {
        self.begin("Asking for the microphone…");
        self.listens.update(|count| *count += 1);
    }

    fn choose(&self) {
        self.begin("Reading the file…");
        self.files.update(|count| *count += 1);
    }

    fn begin(&self, status: &str) {
        self.phase.set(Phase::Starting);
        self.lines.set(Vec::new());
        self.provisional.set(Vec::new());
        self.metrics.set(Metrics::default());
        self.measured.set(true);
        self.status.set(status.into());
    }

    fn stop(&self) {
        self.stops.update(|count| *count += 1);
    }

    fn copy(&self) {
        self.copies.update(|count| *count += 1);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Loading { fraction, detail } => {
                self.fraction.set(fraction);
                self.detail.set(detail);
            }
            Report::Ready { loaded } => self.loaded.set(Some(loaded)),
            Report::Started { phase, status } => {
                self.phase.set(match phase {
                    Started::Listening => Phase::Listening,
                    Started::Transcribing => Phase::Transcribing,
                });
                self.status.set(status);
            }
            Report::Text {
                committed,
                provisional,
                status,
                metrics,
            } => self.text(committed, provisional, status, metrics),
            Report::Done { status, metrics } => {
                self.status.set(status);
                self.metrics.set(metrics);
                self.phase.set(Phase::Idle);
            }
            Report::Error { message } => {
                self.status.set(format!("error: {message}"));
                self.phase.set(Phase::Idle);
            }
            Report::Broken { message } => {
                self.detail.set(message);
                self.phase.set(Phase::Broken);
            }
        }
    }

    fn text(
        &self,
        committed: Vec<Timed>,
        provisional: Vec<Timed>,
        status: String,
        metrics: Metrics,
    ) {
        self.lines.update(|lines| {
            let first = lines.len() as u32;
            let numbered = committed.into_iter().zip(first..);
            lines.extend(numbered.map(|(sentence, id)| Line { id, sentence }));
        });
        let first = self.lines.get().len() as u32;
        let numbered = provisional.into_iter().zip(first..);
        self.provisional.set(
            numbered
                .map(|(sentence, id)| Line { id, sentence })
                .collect(),
        );
        self.status.set(status);
        self.metrics.set(metrics);
    }

    fn summary(&self) -> String {
        self.loaded
            .get()
            .map_or(String::new(), |loaded| loaded.summary())
    }

    fn words(&self) -> String {
        let count = |lines: Vec<Line>| -> usize {
            let words = lines
                .iter()
                .map(|line| line.sentence.text.split_whitespace().count());
            words.sum()
        };
        (count(self.lines.get()) + count(self.provisional.get())).to_string()
    }

    fn loading(&self) -> bool {
        self.loaded.get().is_none() && self.phase.get() != Phase::Broken
    }

    // The model never loaded: likely a bundle that does not match the runtime.
    fn failed_to_load(&self) -> bool {
        self.loaded.get().is_none()
    }

    fn idle(&self) -> bool {
        self.phase.get() == Phase::Idle
    }

    fn can_stop(&self) -> bool {
        matches!(
            self.phase.get(),
            Phase::Starting | Phase::Listening | Phase::Transcribing
        )
    }

    fn listen_label(&self) -> &'static str {
        match self.phase.get() {
            Phase::Listening => "Listening…",
            _ if self.loaded.get().is_none() => "Listen now, transcribe when ready",
            _ => "Listen",
        }
    }

    fn empty(&self) -> bool {
        self.lines.get().is_empty() && self.provisional.get().is_empty()
    }
}

/// Seconds as `m:ss`, or `h:mm:ss` from an hour on.
fn clock(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (minutes, seconds) = (total / SECONDS_PER_MINUTE, total % SECONDS_PER_MINUTE);
    if minutes < MINUTES_PER_HOUR {
        return format!("{minutes}:{seconds:02}");
    }
    let (hours, minutes) = (minutes / MINUTES_PER_HOUR, minutes % MINUTES_PER_HOUR);
    format!("{hours}:{minutes:02}:{seconds:02}")
}

fusor::template!("web/index.html");
