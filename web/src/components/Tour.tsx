import { useEffect, useRef, useState, type ReactNode } from "react";

export interface TourStep {
  /** Element to spotlight. Omit for a centred card with no highlight. */
  target?: string;
  title: string;
  body: ReactNode;
  /** "left" for tall targets like the settings column, where below or above
   *  would put the card off screen. "below-left" aligns the card's left edge
   *  with the target's instead of centring under it. Default picks below,
   *  then above, centred. */
  placement?: "auto" | "left" | "below-left";
}

const PAD = 6;          // breathing room around the spotlight
const GAP = 12;         // between spotlight and card
const CARD = 340;
const MARGIN = 16;      // keep this much clear when scrolling a target in

/** Bottom edge of the sticky header: where the visible content area starts. */
function headerBottom() {
  const h = document.querySelector("header");
  return h ? h.getBoundingClientRect().bottom : 0;
}

/** The sticky header covers the top of the viewport, so "visible" starts below
 *  it — otherwise a target is scrolled to a position it cannot be seen in, and
 *  the spotlight lands on top of the header. */
function topInset() {
  return headerBottom() + MARGIN;
}

/** A short guided tour: dim the page, spotlight one area, explain it.
 *
 *  Positioning is written straight to the DOM inside a requestAnimationFrame
 *  loop rather than held in React state, and neither element carries a CSS
 *  transition. Both are recomputed from the same measurement in the same frame,
 *  so they stay glued to the target - and to each other - while the page
 *  scrolls or reflows. A transition on one of them is what made them drift
 *  apart and lag behind the page. */
export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const spotRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const step = steps[i];

  // Bring the target into view when the step changes; the rAF loop below keeps
  // the spotlight and card pinned to it for the whole smooth scroll.
  //
  // scrollIntoView is too blunt here: on a target taller than the viewport it
  // scrolls even when the top is already sitting there. The rule instead is -
  // if it fits, show all of it including the bottom; if it does not, just make
  // sure the top is comfortably visible, and otherwise leave the page alone.
  useEffect(() => {
    if (!step.target) return;
    const el = document.querySelector(step.target) as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const inset = topInset();
    let delta = 0;
    if (r.height <= vh - inset - MARGIN) {
      if (r.top < inset) delta = r.top - inset;
      else if (r.bottom > vh - MARGIN) delta = r.bottom - (vh - MARGIN);
    } else if (r.top < inset || r.top > vh - 200) {
      delta = r.top - inset;              // tall: just clear the header
    }
    if (delta !== 0) window.scrollBy({ top: delta, behavior: "smooth" });
  }, [step.target]);

  useEffect(() => {
    let raf = 0;
    const layout = () => {
      raf = requestAnimationFrame(layout);
      const spot = spotRef.current, card = cardRef.current;
      if (!card) return;

      const el = step.target
        ? document.querySelector(step.target) as HTMLElement | null
        : null;

      if (!el) {                                   // opener: no target
        if (spot) spot.style.display = "none";
        card.style.position = "fixed";
        card.style.top = "50%";
        card.style.left = "50%";
        card.style.transform = "translate(-50%, -50%)";
        return;
      }

      // Viewport coordinates, and the overlay is position:fixed to match.
      // getBoundingClientRect reports where the target is *now*, so this
      // follows sticky elements (the header and the settings column both are)
      // as well as ones that scroll. Document coordinates cannot: they run away
      // from anything that stays put while the page moves.
      const r = el.getBoundingClientRect();
      const left = r.left - PAD, w = r.width + PAD * 2;

      // Clip the highlight to the area you can actually see. A sticky target
      // can slide up under the header, and an unclipped spotlight follows it -
      // running off the top of the viewport and outlining part of the header
      // instead of the thing it is meant to be pointing at.
      const hb = headerBottom();
      const visTop = Math.max(r.top - PAD, hb + 2);
      const visBottom = Math.min(r.bottom + PAD, window.innerHeight - 2);
      const visH = visBottom - visTop;
      if (spot) {
        spot.style.display = visH < 8 ? "none" : "";
        spot.style.transform = `translate(${left}px, ${visTop}px)`;
        spot.style.width = `${w}px`;
        spot.style.height = `${Math.max(0, visH)}px`;
      }
      // The card still tracks the target's real top, clamped below the header.
      const top = r.top - PAD, h = r.height + PAD * 2;

      const inset = topInset();
      const clampX = (x: number) =>
        Math.min(Math.max(12, x), window.innerWidth - CARD - 12);
      const ch = card.offsetHeight || 200;
      const clampY = (y: number) =>
        Math.min(Math.max(inset, y), window.innerHeight - ch - 12);

      let cx: number, cy: number;
      if (step.placement === "left") {
        // A tall target has no room above or below: sit beside it, top-aligned.
        cx = clampX(left - GAP - CARD);
        cy = clampY(top);
      } else {
        cx = clampX(step.placement === "below-left"
          ? left                                   // align with the target edge
          : left + w / 2 - CARD / 2);              // centred under it
        const below = top + h + GAP;
        cy = window.innerHeight - below > ch + 12 ? below : clampY(top - GAP - ch);
      }
      card.style.position = "fixed";
      card.style.top = "0";
      card.style.left = "0";
      card.style.transform = `translate(${cx}px, ${cy}px)`;
    };
    raf = requestAnimationFrame(layout);
    return () => cancelAnimationFrame(raf);
  }, [step.target, step.placement, i]);

  // Overscroll bounce moves the rendered page without moving the layout
  // viewport, so a fixed overlay detaches from its target at the scroll ends.
  // Suppress the bounce for the duration of the tour instead of chasing it.
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.style.overscrollBehavior;
    root.style.overscrollBehavior = "none";
    return () => { root.style.overscrollBehavior = prev; };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((n) => Math.min(steps.length - 1, n + 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, steps.length]);

  const last = i === steps.length - 1;
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Quick use">
      {/* The spotlight's huge box-shadow does the dimming when there is a
          target; with no target the scrim has to do it itself. */}
      <div className={"tour-scrim" + (step.target ? "" : " dim")} onClick={onClose} />
      <div ref={spotRef} className="tour-spot" />
      <div ref={cardRef} className="tour-card" style={{ width: CARD }}>
        <div className="tour-head">
          <span className="tour-step">
            {i === 0 ? "Quick use" : `Step ${i} of ${steps.length - 1}`}
          </span>
          <button className="tour-x" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <h3>{step.title}</h3>
        <div className="tour-body">{step.body}</div>
        <div className="tour-foot">
          <span className="tour-dots">
            {steps.map((_, n) => (
              <i key={n} className={n === i ? "on" : ""} onClick={() => setI(n)} />
            ))}
          </span>
          <span className="spacer" />
          {i > 0 ? <button className="mini" onClick={() => setI(i - 1)}>Back</button> : null}
          <button className="mini primary"
            onClick={() => (last ? onClose() : setI(i + 1))}>
            {last ? "Done" : i === 0 ? "Start" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
