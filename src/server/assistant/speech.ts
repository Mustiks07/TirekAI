// T028: replaceable speech-to-text contract. No speech provider is configured in this
// environment, so voice reports not_configured; no endpoint is invented and no audio is stored.
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
  transcribe(r: {
    audio: Buffer;
    mime: string;
    locale: "ru" | "kk";
    signal: AbortSignal;
  }): Promise<Transcription>;
}
export function configuredSpeech(): SpeechProvider | null {
  return null;
}
export function speechStatus(p: SpeechProvider | null) {
  return p
    ? { status: "configured" as const, provider: p.name }
    : { status: "not_configured" as const, provider: null };
}
