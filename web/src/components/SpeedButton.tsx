import { formatSpeed, nextSpeed, setSpeed, usePlaybackSpeed } from "../audio/speed";

/**
 * The playback speed, as a small button that shows it ("1.5×") and steps to the next speed on a
 * tap: 0.5× to 4×, then round again. One speed for every player, so every button shows the same.
 */
export function SpeedButton({ label = "Playback speed", className = "" }: { label?: string; className?: string }) {
  const speed = usePlaybackSpeed();
  const next = nextSpeed(speed);
  const name = `${label}: ${formatSpeed(speed)}. Change to ${formatSpeed(next)}`;
  return (
    <button type="button" className={`speed-btn${className ? ` ${className}` : ""}`} onClick={() => setSpeed(next)} aria-label={name} title={name}>
      {formatSpeed(speed)}
    </button>
  );
}
