/** Radar gets its own cooler, near-neutral dark canvas — so cyan reads as a
 *  crisp accent instead of teal-on-teal, and Radar feels distinct from Terrain's
 *  warm teal-green palette. Applies to every /radar route. */
export default function RadarLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#0b0e10]">{children}</div>;
}
