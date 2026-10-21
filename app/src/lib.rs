//! The Parakeet Redux page. Listening, transcribing a file, the model's loading and the live
//! measurements are signals here; `web/app.js` runs the engine worker, the microphone and the
//! file decoding, and reports back through `engine` events.

mod app;
