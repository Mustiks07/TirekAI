// Pure audio helpers for the local speech process (no model, no side effects; unit-tested).
export const RATE = 16000;
// PCM16 / float32 WAV, any channel count and rate → mono 16 kHz float samples.
export function decodeWav(b) {
  if (
    b.length < 44 ||
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("VOICE_FORMAT");
  let o = 12,
    data = null,
    fmt = null;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4),
      size = b.readUInt32LE(o + 4);
    if (id === "fmt ")
      fmt = {
        format: b.readUInt16LE(o + 8),
        channels: b.readUInt16LE(o + 10),
        rate: b.readUInt32LE(o + 12),
        bits: b.readUInt16LE(o + 22),
      };
    if (id === "data")
      data = b.subarray(o + 8, Math.min(b.length, o + 8 + size));
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.channels < 1 || fmt.rate < 8000 || fmt.rate > 192000)
    throw new Error("VOICE_FORMAT");
  const pcm16 = fmt.format === 1 && fmt.bits === 16,
    f32 = fmt.format === 3 && fmt.bits === 32;
  if (!pcm16 && !f32) throw new Error("VOICE_FORMAT");
  const step = (fmt.bits / 8) * fmt.channels,
    frames = Math.floor(data.length / step),
    mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const at = i * step + c * (fmt.bits / 8);
      s += pcm16 ? data.readInt16LE(at) / 32768 : data.readFloatLE(at);
    }
    mono[i] = s / fmt.channels;
  }
  if (fmt.rate === RATE) return mono;
  const ratio = fmt.rate / RATE,
    out = new Float32Array(Math.floor(frames / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio,
      k = Math.floor(x),
      t = x - k;
    out[i] = mono[k] * (1 - t) + (mono[Math.min(k + 1, frames - 1)] ?? 0) * t;
  }
  return out;
}
// Mono float samples → PCM16 WAV (used by evaluation tools; the browser has its own encoder).
// Quiet audio is peak-normalized BEFORE 16-bit quantization: measured on FLEURS kk, a quiet
// clip quantized as is sent Whisper into an endless repetition, the normalized one did not.
export function encodeWav(input, rate = RATE) {
  const samples = normalizePeak(input);
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    b.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767),
      44 + i * 2,
    );
  return b;
}
export function normalizePeak(samples, maxGain = 30) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  if (peak < 1e-4) return samples;
  const gain = Math.min(maxGain, 0.9 / peak);
  return gain <= 1 ? samples : samples.map((v) => v * gain);
}
