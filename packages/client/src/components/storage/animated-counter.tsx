import { useEffect, useRef, useState } from "react";

interface AnimatedCounterProps {
  value: number;
  duration?: number;
  className?: string;
}

export function AnimatedCounter({
  value,
  duration = 400,
  className,
}: AnimatedCounterProps) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) {
      setDisplay(to);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / Math.max(1, duration));
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(from + (to - from) * eased);
      setDisplay(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      fromRef.current = to;
    };
  }, [value, duration]);

  return <span className={className}>{display.toLocaleString()}</span>;
}
