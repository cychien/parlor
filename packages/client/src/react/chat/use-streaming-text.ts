import { useEffect, useRef, useState } from "react";

const FRAME_MS = 32;
const FIRST_GAP_MS = 250;
const MIN_GAP_MS = 60;
const MAX_GAP_MS = 1_000;
const SETTLE_MS = 180;

const clamp = (value: number) => Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, value));

/** Never ends inside a surrogate pair, so an emoji is shown whole or not at all. */
function boundary(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at + 1 : at;
}

/**
 * A streaming reply's text, revealed at the pace it arrives instead of a batch at a time:
 * what came in is spread over the time until the next batch is expected, and the rest
 * shows within a moment once `streaming` ends. Text there at mount shows at once.
 */
export function useStreamingText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text.length);
  const shownNow = useRef(shown);
  const pace = useRef({
    text,
    arrivedAt: undefined as number | undefined,
    gap: FIRST_GAP_MS,
    rate: 0,
  });

  useEffect(() => {
    shownNow.current = shown;
  }, [shown]);

  useEffect(() => {
    const p = pace.current;
    const previous = p.text;
    p.text = text;
    if (!text.startsWith(previous.slice(0, shownNow.current))) {
      setShown(text.length);
      return;
    }
    if (text.length > previous.length) {
      const now = performance.now();
      if (p.arrivedAt !== undefined)
        p.gap = clamp(0.7 * p.gap + 0.3 * (now - p.arrivedAt));
      p.arrivedAt = now;
    }
    p.rate = (text.length - shownNow.current) / (streaming ? p.gap : SETTLE_MS);
  }, [text, streaming]);

  useEffect(() => {
    if (shown >= text.length) return;
    const timer = setTimeout(() => {
      setShown((current) => {
        const step = Math.max(1, Math.round(pace.current.rate * FRAME_MS));
        return Math.min(text.length, boundary(text, current + step));
      });
    }, FRAME_MS);
    return () => clearTimeout(timer);
  }, [shown, text]);

  return shown >= text.length ? text : text.slice(0, shown);
}
