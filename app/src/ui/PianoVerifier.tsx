import { keyName } from "../dsp/key";
interface Props { context: AudioContext; tonic: number; mode: "major" | "minor" }
export function PianoVerifier({ context, tonic, mode }: Props) {
  const play = async (notes: number[]) => {
    await context.resume();
    const at = context.currentTime;
    for (const note of notes) {
      const osc = context.createOscillator(); const gain = context.createGain();
      osc.frequency.value = 440 * 2 ** ((60 + note - 69) / 12);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.06 / notes.length, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 1);
      osc.connect(gain); gain.connect(context.destination);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      osc.start(at); osc.stop(at + 1.05);
    }
  };
  return <div className="grid-editor"><h3>Key verifier</h3>
    <p className="muted">Compare these reference tones with the track by ear.</p>
    <div className="transport">{Array.from({ length: 12 }, (_, note) =>
      <button key={note} onClick={() => void play([note])}>{keyName(note, "major").replace(" major", "")}</button>)}</div>
    <button onClick={() => void play([tonic, tonic + (mode === "minor" ? 3 : 4), tonic + 7])}>Play {keyName(tonic, mode)} chord</button>
  </div>;
}
