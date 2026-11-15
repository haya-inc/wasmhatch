import { useEffect, useMemo, useRef } from "react";
import {
  describeOffice,
  hitTestOffice,
  officeGrid,
  renderOffice,
  type OfficeCharacter
} from "../lib/pixel-office";

const FRAME_MS = 300;

/**
 * The pixel office: every hatchling is a chick at a desk, and what it is
 * doing right now is readable at a glance (and in the aria-label — the
 * canvas never carries information that is not also available as text).
 * Clicking a desk selects that hatchling's chat.
 */
export function HatchlingOffice({
  characters,
  onSelect
}: {
  characters: readonly OfficeCharacter[];
  onSelect: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const { width, height } = officeGrid(characters.length);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      renderOffice(ctx, charactersRef.current, frame);
    };
    draw();
    const timer = setInterval(() => {
      // A hidden tab throttles this timer; that only pauses the decoration.
      if (document.visibilityState === "hidden") return;
      frame += 1;
      draw();
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [width, height]);

  const label = useMemo(() => describeOffice(characters), [characters]);

  return (
    <canvas
      ref={canvasRef}
      className="hatchling-office"
      width={width}
      height={height}
      role="img"
      aria-label={label}
      onClick={(event) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const bounds = canvas.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / bounds.width) * width;
        const y = ((event.clientY - bounds.top) / bounds.height) * height;
        const index = hitTestOffice(charactersRef.current.length, x, y);
        if (index !== null) onSelect(charactersRef.current[index].id);
      }}
    />
  );
}
