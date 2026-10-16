// Browser-side conversion of a microphone recording to 16 kHz mono PCM16 WAV, the format the
// local speech engine accepts. Decoding uses the browser's own codecs, so the server needs none.
export async function toWav16k(blob: Blob): Promise<Blob> {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
    const offline = new OfflineAudioContext(1, frames, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new Blob([pcm16Wav(rendered.getChannelData(0), 16000)], {
      type: "audio/wav",
    });
  } finally {
    await ctx.close().catch(() => {});
  }
}
// Quiet recordings are peak-normalized before 16-bit quantization (bounded gain): a quiet clip
// quantized as is made the local Whisper model repeat itself in our measurements.
export function pcm16Wav(input: Float32Array, rate: number) {
  let peak = 0;
  for (const v of input) peak = Math.max(peak, Math.abs(v));
  const gain = peak < 1e-4 ? 1 : Math.min(30, Math.max(1, 0.9 / peak));
  const samples = gain === 1 ? input : input.map((v) => v * gain);
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at: number, s: string) =>
    [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  ascii(36, "data");
  out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    out.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767),
      true,
    );
  return out.buffer;
}
