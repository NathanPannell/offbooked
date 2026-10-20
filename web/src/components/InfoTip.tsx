import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A small (i) that explains something. A mouse shows it on hover; a click, tap or Enter pins it
 * open (or closes it again), and Escape or a tap elsewhere closes it. Screen readers get the text
 * as the button's description.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setPinned(false);
        setHovered(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPinned(false);
        setHovered(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={root}
      className="info-tip"
      // Only a real mouse hovers; on touch the tap below does the work.
      onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(false)}
    >
      <button
        type="button"
        className="icon-btn info-tip-btn"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setPinned((p) => !p)}
      >
        <Info size={16} aria-hidden="true" />
      </button>
      <span role="tooltip" id={id} className="info-tip-text" hidden={!open}>
        {children}
      </span>
    </span>
  );
}
