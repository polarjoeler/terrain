/** Radar gets its own cooler, near-neutral dark canvas — so cyan reads as a
 *  crisp accent instead of teal-on-teal, and Radar feels distinct from Terrain's
 *  warm teal-green palette. Applies to every /radar route.
 *
 *  The inline <style> paints html/body the same neutral, so the overscroll
 *  ("rubber-band") area doesn't flash Terrain's teal body background. It only
 *  applies while a /radar route is mounted; navigating away reverts it. */
export default function RadarLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0b0e10]">
      <style>{`html,body{background:#0b0e10}`}</style>
      {children}
    </div>
  );
}
