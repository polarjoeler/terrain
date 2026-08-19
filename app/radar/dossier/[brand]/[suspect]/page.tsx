import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { buildDossier, dmcaNotice } from "@/lib/radar/dossier";
import { brandsForEmail } from "@/lib/radar/brands";
import { CopyPrint } from "./copy-print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Radar — Takedown dossier" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 border-b border-cream/8 py-2.5 text-sm">
      <div className="text-cream/40">{label}</div>
      <div className="text-cream/85">{children}</div>
    </div>
  );
}

export default async function DossierPage({
  params,
}: {
  params: Promise<{ brand: string; suspect: string }>;
}) {
  const p = await params;
  const brand = decodeURIComponent(p.brand);
  const suspect = decodeURIComponent(p.suspect);

  const email = await currentUser();
  if (!email) redirect("/login");
  const owns = isAdmin(email) || (await brandsForEmail(email)).some((b) => b.brandDomain === brand);
  if (!owns) redirect("/radar/dashboard");

  const d = await buildDossier(brand, suspect);
  if (!d) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24 text-center">
        <h1 className="font-display text-3xl text-cream">Detection not found</h1>
        <Link href="/radar/dashboard" className="mt-6 inline-block text-cyan underline">
          ← Back to dashboard
        </Link>
      </main>
    );
  }

  const notice = dmcaNotice(d);
  const whois = `https://who.is/whois/${d.suspect}`;

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <Link href="/radar/dashboard" className="text-sm text-cream/50 hover:text-cream print:hidden">
        ← Dashboard
      </Link>

      <header className="mt-6">
        <span className="inline-block rounded-full border border-cyan/30 bg-cyan/10 px-4 py-1.5 text-xs font-medium text-cyan">
          ◎ Takedown dossier
        </span>
        <h1 className="mt-4 font-display text-4xl leading-tight tracking-tight text-cream md:text-5xl">
          <span className="font-mono text-cyan">{d.suspect}</span> is copying{" "}
          {d.brandName}
        </h1>
        <p className="mt-3 text-cream/55">
          Evidence pack and ready-to-file takedown notice. Generated {d.generatedAt.slice(0, 10)}.
        </p>
      </header>

      {/* Evidence */}
      <section className="mt-10 rounded-[2rem] border border-cyan/20 bg-cyan/[0.04] p-6 md:p-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-cream">The evidence</h2>
          <span className="rounded-full bg-cyan px-3 py-1 text-xs font-bold text-cyan-deep">
            {d.verdict} · {d.score}/100
          </span>
        </div>
        <ul className="mt-4 space-y-2 text-sm">
          {d.reasons.map((r, i) => (
            <li key={i} className="flex gap-2 text-cream/80"><span className="text-cyan">›</span>{r}</li>
          ))}
        </ul>
        <div className="mt-5">
          <Row label="Rights holder">{d.brandName} ({d.officialDomains.join(", ")})</Row>
          {d.trademark && <Row label="Trademark">{d.trademark}</Row>}
          <Row label="Infringer">{d.suspect}</Row>
          <Row label="First detected">{d.firstSeen.slice(0, 10)}</Row>
          <Row label="Last confirmed">{d.lastSeen.slice(0, 10)}</Row>
        </div>
      </section>

      {/* Where it's hosted / registered */}
      <section className="mt-6 rounded-[2rem] border border-cream/12 p-6 md:p-8">
        <h2 className="text-lg font-semibold text-cream">Where to report it</h2>
        <div className="mt-4">
          <Row label="Registrar">
            {d.registrar ?? <span className="text-cream/40">unknown — look up below</span>}
          </Row>
          <Row label="Abuse contact">
            {d.registrarAbuse ? (
              <a href={`mailto:${d.registrarAbuse}`} className="text-cyan hover:underline">{d.registrarAbuse}</a>
            ) : (
              <span className="text-cream/40">not published — use the WHOIS lookup</span>
            )}
          </Row>
          {d.nameservers.length > 0 && <Row label="Nameservers">{d.nameservers.join(", ")}</Row>}
          {d.ips.length > 0 && <Row label="Host IP">{d.ips.join(", ")}</Row>}
          <Row label="WHOIS lookup">
            <a href={whois} target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">{whois}</a>
          </Row>
        </div>

        <div className="mt-6 space-y-3 text-sm text-cream/70">
          <p className="font-semibold text-cream/85">Filing steps:</p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              <span className="text-cream/85">Report to Shopify</span> — the clone is a Shopify store. File the DMCA notice below at{" "}
              <a href="https://www.shopify.com/legal/dmca" target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">shopify.com/legal/dmca</a>.
            </li>
            <li>
              <span className="text-cream/85">Report to the registrar</span> — send the notice to the abuse contact above (or the one from the WHOIS lookup).
            </li>
            <li>
              <span className="text-cream/85">Report the domain</span> to Google Safe Browsing at{" "}
              <a href="https://safebrowsing.google.com/safebrowsing/report_phish/" target="_blank" rel="noopener noreferrer" className="text-cyan hover:underline">safebrowsing.google.com</a> to warn shoppers.
            </li>
          </ol>
        </div>
      </section>

      {/* DMCA notice */}
      <section className="mt-6 rounded-[2rem] border border-cream/12 p-6 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-cream">Ready-to-file DMCA notice</h2>
          <CopyPrint text={notice} />
        </div>
        <p className="mt-2 text-sm text-cream/45 print:hidden">Fill the [bracketed] fields with your details before sending.</p>
        <pre className="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-2xl border border-cream/12 bg-ink-deep/60 p-5 font-mono text-xs leading-relaxed text-cream/80">
{notice}
        </pre>
      </section>

      <p className="mt-8 text-center text-xs text-cream/40">
        Radar, part of Tembo Commerce · This is a template, not legal advice — have your legal team review before filing.
      </p>
    </main>
  );
}
