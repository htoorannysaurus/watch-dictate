// Local speech-to-text: ffmpeg decodes the watch's AAC clip to 16 kHz mono float PCM,
// and NVIDIA Parakeet TDT 0.6B v2 (int8, via sherpa-onnx) transcribes it. The model is
// loaded once at startup and stays resident.

import { spawn } from 'node:child_process';
import path from 'node:path';
import sherpa from 'sherpa-onnx-node';

export async function loadRecognizer(modelDir, numThreads = 6) {
  const f = (name) => path.join(modelDir, name);
  return sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: f('encoder.int8.onnx'), decoder: f('decoder.int8.onnx'), joiner: f('joiner.int8.onnx') },
      tokens: f('tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
  });
}

/** Decodes any ffmpeg-readable file (AAC in MP4 needs a seekable file, not a pipe). */
export function decodeToPcm(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1']);
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { err += c; });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 300)}`));
      const buf = Buffer.concat(chunks);
      // Copy into an aligned buffer; Buffer.concat's offset may not be 4-byte aligned.
      const samples = new Float32Array(buf.length / 4);
      new Uint8Array(samples.buffer).set(buf.subarray(0, samples.length * 4));
      resolve(samples);
    });
  });
}

/** `run` wraps each piece's decode (the server's one-at-a-time queue), so a short note
 *  can slip in between the pieces of a long one instead of waiting for all of it. */
export async function transcribe(recognizer, samples, run = (fn) => fn()) {
  // Parakeet's cost and memory grow faster than linearly with length (5 min in one pass:
  // 58 s and 3.6 GB), so long notes are cut at pauses into pieces and joined.
  const parts = [];
  for (const [start, end] of splitAtPauses(samples)) {
    const result = await run(() => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: samples.subarray(start, end), sampleRate: 16000 });
      return recognizer.decodeAsync(stream);
    });
    if (result.text.trim()) parts.push(result.text.trim());
  }
  return parts.join(' ');
}

const RATE = 16000;
const FRAME = 480;              // 30 ms
const MAX_CHUNK = 25 * RATE;    // never longer than this
const MIN_CHUNK = 12 * RATE;    // look for the quietest spot after this

/** [start, end) sample ranges, each <= 25 s, cut at the quietest 30 ms frame. */
export function splitAtPauses(samples) {
  const ranges = [];
  let start = 0;
  while (samples.length - start > MAX_CHUNK) {
    let best = start + MAX_CHUNK, bestEnergy = Infinity;
    for (let f = start + MIN_CHUNK; f + FRAME <= start + MAX_CHUNK; f += FRAME) {
      let e = 0;
      for (let i = f; i < f + FRAME; i++) e += samples[i] * samples[i];
      if (e < bestEnergy) { bestEnergy = e; best = f + FRAME / 2; }
    }
    ranges.push([start, best]);
    start = best;
  }
  ranges.push([start, samples.length]);
  return ranges;
}
