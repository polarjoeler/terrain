/** Radar gets its own calm, near-neutral dark canvas — so cyan reads as a crisp
 *  accent instead of teal-on-teal, and Radar feels distinct from Terrain's warm
 *  teal-green palette. Applies to every /radar route.
 *
 *  The shared app <body> is Terrain's dark TEAL (--color-ink-deep). A previous
 *  inline <style> override of html/body raced against that body rule in the
 *  production build (specificity tie + style hoisting), which flickered the whole
 *  page teal↔dark as the page animated. The fix is an always-present opaque
 *  backdrop element behind the content: the body can never show through, whatever
 *  the cascade does. The html/body !important line only covers the overscroll
 *  ("rubber-band") strip outside the fixed backdrop. */
export default function RadarLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-[#0b0e10]">
      <style>{`html,body{background-color:#0b0e10 !important}`}</style>
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-[#0b0e10]" />
      {children}
    </div>
  );
}
