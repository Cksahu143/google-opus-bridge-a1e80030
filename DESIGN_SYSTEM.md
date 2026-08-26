# Animated Web Design System (2026)

A portable reference for building genuinely award-tier animated websites.
Plain markdown on purpose -- readable and usable by any AI assistant
(ChatGPT, Claude, etc.) or any human, with no dependency on this repo's
tooling or MCP setup. Drop it into any project's context.

Grounded in independently verified, current (2026) sources: Steel/GSAP/
Mintec engineering blogs and Awwwards-adjacent judging criteria, not
assumed from stale training data. Sources noted inline where a claim is
specific enough to matter.

## The core principle award judges actually apply

Three things, and missing any one caps the result at merely "nice":

1. **Motion with a director.** Transitions carry meaning, scroll
   sequences pace a story, micro-interactions reward attention on
   purpose -- not animation sprinkled on everything.
2. **Restraint.** The best 2026 sites are described as "a masterclass in
   restraint" -- confident typography and weighted smooth scroll,
   transitions that never call attention to themselves.
3. **Performance discipline.** A 3D hero that drops to 18fps on a
   mid-range Android, or a 9MB page that takes six seconds to paint,
   loses regardless of how good the concept is. Judges test on real
   devices, not just a dev's desktop. "Beauty at 60fps is the whole
   discipline."

If you only take one rule from this document: **default to the platform,
reach for a library only when the platform can't do it.**

## Decision framework: what to reach for

As of 2026, native CSS covers far more than it used to. A 2026
engineering write-up migrating a real corporate site put it plainly:
start by assuming CSS can do it; only reach for GSAP when you need
*programmatic* control (play/pause/reverse, sequencing, index-based
stagger) -- not the other way around. Roughly 70% of what used to require
ScrollMagic/GSAP could be replaced with native scroll-driven animations
and View Transitions, with fewer cross-browser bugs and less JS shipped.

| Need | Reach for |
|---|---|
| Fade/slide/scale reveal as element enters viewport | CSS `animation-timeline: view()` (Scroll-Driven Animations) |
| Value tied to scroll position (e.g. progress bar, parallax) | CSS `animation-timeline: scroll()` |
| Same-page navigation transition (SPA route change) | View Transitions API (`document.startViewTransition`) |
| Cross-document navigation transition (MPA / full page load) | Cross-document View Transitions (`@view-transition { navigation: auto }`) -- fully cross-browser in 2026 |
| **Pinning** (element sticks while content scrolls past) | GSAP ScrollTrigger -- the CSS spec deliberately does not include pinning; GSAP wins here, full stop |
| Complex timelines, precise sequencing, physics-y easing (elastic/back/bounce) | GSAP core + eases -- now free, including previously-paid plugins like ScrollTrigger and SplitText |
| React component-level animation, layout animations, gestures | Motion (formerly Framer Motion) -- most idiomatic for React |
| List reordering with FLIP-style animation | `view-transition-group` (landing 2026-2027) today, GSAP Flip plugin now |

Don't reach for a JS animation library as a default. Prototype the CSS
version first; only escalate when you hit pinning or real sequencing
needs.

## Design tokens (starting point -- adapt palette per brand)

```css
:root {
  /* Type scale: 1.25 (major third) ratio, one base size */
  --font-size-xs: 0.75rem;
  --font-size-sm: 0.875rem;
  --font-size-base: 1rem;
  --font-size-lg: 1.25rem;
  --font-size-xl: 1.563rem;
  --font-size-2xl: 1.953rem;
  --font-size-3xl: 2.441rem;
  --font-size-4xl: 3.052rem;

  /* Spacing: 4px base unit, doubles past the middle for dramatic gaps */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-12: 3rem;
  --space-16: 4rem;
  --space-24: 6rem;
  --space-32: 8rem;

  /* Motion tokens -- name durations/eases, don't hardcode magic numbers
     scattered through the codebase */
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out-quart: cubic-bezier(0.76, 0, 0.24, 1);
  --duration-fast: 150ms;
  --duration-base: 400ms;
  --duration-slow: 800ms;
  --duration-page: 1200ms;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration-base: 0ms;
    --duration-slow: 0ms;
    --duration-page: 0ms;
  }
}
```

Always respect `prefers-reduced-motion`. It's both an accessibility
requirement and, per the judging criteria above, a sign of craft --
sloppy sites ignore it.

## Concrete patterns

### 1. Scroll reveal (native CSS, no JS at all)

```css
.reveal {
  opacity: 0;
  transform: translateY(24px);
  animation: reveal-in linear both;
  animation-timeline: view();
  animation-range: entry 0% cover 30%;
}

@keyframes reveal-in {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

Apply `.reveal` to any element; it animates in exactly once as it enters
the viewport, tied to real scroll position, zero JavaScript, zero layout
thrash. This is the default choice for section-entrance animation in
2026 -- only drop to GSAP if you also need to *reverse* it, sequence it
against siblings, or pin something.

### 2. Page transition (View Transitions API, SPA)

```js
function navigate(url) {
  if (!document.startViewTransition) {
    location.href = url; // graceful fallback, older browsers
    return;
  }
  document.startViewTransition(async () => {
    await router.push(url); // swap in your router's navigation call
  });
}
```

```css
::view-transition-old(root) {
  animation: fade-out var(--duration-base) var(--ease-in-out-quart);
}
::view-transition-new(root) {
  animation: fade-in var(--duration-base) var(--ease-in-out-quart);
}
```

For a specific element (e.g. a hero image) to morph between pages rather
than cross-fade, give it a stable `view-transition-name` on both pages:

```css
.hero-image {
  view-transition-name: hero;
}
```

### 3. Pinned scroll sequence (GSAP -- the one thing CSS can't do)

```js
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
gsap.registerPlugin(ScrollTrigger);

gsap.timeline({
  scrollTrigger: {
    trigger: ".pin-section",
    start: "top top",
    end: "+=200%", // pins for 2x the viewport height of scroll
    pin: true,
    scrub: 1, // ties timeline progress directly to scroll position
  },
})
  .to(".pin-section h1", { scale: 1.4, ease: "none" })
  .to(".pin-section .bg", { opacity: 0.3, ease: "none" }, "<"); // "<" = same start time as previous tween
```

### 4. Staggered reveal (GSAP -- needs index-based sequencing)

```js
gsap.from(".card", {
  y: 40,
  opacity: 0,
  duration: 0.6,
  ease: "var(--ease-out-expo)",
  stagger: 0.08,
  scrollTrigger: { trigger: ".card-grid", start: "top 80%" },
});
```

### 5. Magnetic button (a common "feels expensive" micro-interaction)

```js
function magnetic(el, strength = 0.3) {
  el.addEventListener("mousemove", (e) => {
    const { left, top, width, height } = el.getBoundingClientRect();
    const x = (e.clientX - left - width / 2) * strength;
    const y = (e.clientY - top - height / 2) * strength;
    el.style.transform = `translate(${x}px, ${y}px)`;
  });
  el.addEventListener("mouseleave", () => {
    el.style.transform = "translate(0, 0)";
  });
}
```

Pair with `transition: transform var(--duration-fast) var(--ease-out-expo)`
in CSS so the release snaps back smoothly.

## Performance checklist (non-negotiable for award-tier)

- Animate only `transform` and `opacity` where possible -- both are
  compositor-only properties that skip layout/paint. Animating `width`,
  `top`/`left`, or `box-shadow` directly causes layout thrash.
- Test on a real mid-range Android, not just your dev machine. Judges
  do, and so should you.
- Keep total page weight sane -- a 9MB hero video is a loss condition
  regardless of how good it looks on fiber.
- `will-change` is a hint, not a fix -- apply it narrowly to elements
  about to animate, remove it after, don't blanket-apply it.
- Always provide the `prefers-reduced-motion` fallback shown above.

## Stack recommendation for a new project

- **Framework**: Next.js (the most common stack among 2026's actual
  award winners, paired with GSAP) or any React/Vite setup.
- **Styling**: Tailwind for the design-token layer, hand-written CSS for
  the animation-timeline/view-transition rules above (Tailwind doesn't
  have first-class support for either yet).
- **Motion**: native CSS first (sections 1-2 above) -- reach for GSAP
  only for pinning/sequencing (sections 3-4), Motion (Framer Motion) if
  the project is React-component-animation-heavy rather than
  scroll-driven.
- **Typography**: pick one confident display face + one workhorse text
  face. Editorial-grade type carried more than one 2026 award winner
  entirely on typographic confidence plus restrained motion -- it
  doesn't require a 3D hero to read as premium.
