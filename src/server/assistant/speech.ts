// T028/T056: replaceable speech-to-text contract. SPEECH_PROVIDER=local selects the local
// Whisper process (local-speech.ts); otherwise voice reports not_configured. No audio is stored.
import { localSpeech } from "./local-speech";
export type Transcription = {
  text: string;
  locale: "ru" | "kk";
  // Recognition confidence 0..1 when the provider reports it; null when unknown.
  confidence: number | null;
  // Segments the provider marked uncertain; the UI asks the user to confirm them.
  uncertain: string[];
};
export interface SpeechProvider {
  readonly name: string;
  // Per-request deadline; local CPU models need longer than a hosted service.
  readonly timeoutMs?: number;
  // Optional preparation (model load) before the first request.
  warm?(): Promise<void>;
  transcribe(r: {
    audio: Buffer;
    mime: string;
    locale: "ru" | "kk";
    signal: AbortSignal;
  }): Promise<Transcription>;
}
export function configuredSpeech(): SpeechProvider | null {
  return process.env.SPEECH_PROVIDER === "local" ? localSpeech() : null;
}
export function speechStatus(p: SpeechProvider | null) {
  return p
    ? { status: "configured" as const, provider: p.name }
    : { status: "not_configured" as const, provider: null };
}
