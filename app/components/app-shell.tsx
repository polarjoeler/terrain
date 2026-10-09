"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark, TerrainMark } from "@/app/components/logo";

/** The authenticated application shell: labelled left sidebar + compact top bar + account menu.
 *  Server pages render their content as children; the (app) route-group layout supplies `user` and
 *  `billing`. Nav links point at real existing routes; not-yet-built destinations are marked "soon".
 *  Responsive: the sidebar collapses to a drawer on mobile and to an icon rail on desktop (click the
 *  chevron — the choice is remembered per browser). The page title is derived from the route. */

// 20×20 stroke icons (so the rail stays usable when collapsed).
const I = (d: React.ReactNode) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] shrink-0" aria-hidden>{d}</svg>
);
const ICONS: Record<string, React.ReactNode> = {
  Overview: I(<><rect x="2.5" y="2.5" width="6" height="6" rx="1.3" /><rect x="11.5" y="2.5" width="6" height="6" rx="1.3" /><rect x="2.5" y="11.5" width="6" height="6" rx="1.3" /><rect x="11.5" y="11.5" width="6" height="6" rx="1.3" /></>),
  Leads: I(<><path d="M3 5h14M3 10h14M3 15h9" /></>),
  "Saved lists": I(<><path d="M5 2.75h10a1 1 0 0 1 1 1V17l-6-3.2L4 17V3.75a1 1 0 0 1 1-1Z" /></>),
  Intelligence: I(<><path d="M3 17V3M3 17h14M6.5 14l3-4 3 2.5L17 6" /></>),
  Discover: I(<><circle cx="10" cy="10" r="7.25" /><path d="m12.8 7.2-1.9 4.9-4.9 1.9 1.9-4.9 4.9-1.9Z" /></>),
  Digests: I(<><rect x="2.75" y="4.25" width="14.5" height="11.5" rx="1.5" /><path d="m3.2 5 6.8 5 6.8-5" /></>),
};

type NavLeaf = { label: string; href?: string; soon?: boolean; match?: string[] };
type NavNode = NavLeaf & { children?: NavLeaf[] };

const NAV: NavNode[] = [
  { label: "Overview", href: "/overview" },
  { label: "Leads", href: "/dashboard", match: ["/dashboard"] },
  { label: "Saved lists", href: "/lists" },
  { label: "Intelligence", href: "/insights", match: ["/insights", "/p"] },
  {
    label: "Discover", children: [
      { label: "Partner Finder", href: "/partners" },
      { label: "Fraud Scanner", href: "/radar/dashboard", match: ["/radar"] },
      { label: "Store Groups", soon: true },
      { label: "Creator Leads", soon: true },
    ],
  },
  { label: "Digests", href: "/digests" },
];
const SIDEBAR_KEY = "terrain.sidebar.collapsed";

// Route → page title. Longest matching prefix wins; falls back to the active nav label.
const TITLES: Record<string, string> = {
  "/overview": "Overview", "/dashboard": "Leads", "/lists": "Saved lists",
  "/insights": "Intelligence", "/partners": "Partner Finder", "/radar": "Fraud Scanner",
  "/digests": "Digests", "/account": "Account & workspace",
};
function titleFor(pathname: string): string {
  const hit = Object.keys(TITLES)
    .filter((p) => pathname === p || pathname.startsWith(p + "/"))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? TITLES[hit] : "Terrain";
}

function isActive(pathname: string, leaf: NavLeaf): boolean {
  const target = (leaf.href ?? "").split("?")[0];
  if (!target) return false;
  if (leaf.match) return leaf.match.some((m) => pathname === m || pathname.startsWith(m + "/"));
  return pathname === target || pathname.startsWith(target + "/");
}

export type ShellUser = { name: string; email: string; workspace: string; role: string; initials: string };
export type ShellBilling = { trialDays: number | null; pastDue: boolean };

export function AppShell({ pageTitle, user, billing, children }: {
  pageTitle?: string; user: ShellUser; billing?: ShellBilling; children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const activeSection = NAV.find((n) => n.children?.some((c) => isActive(pathname, c)))?.label;
  const [open, setOpen] = useState<string | null>(activeSection ?? "Discover");
  const title = pageTitle ?? titleFor(pathname);

  // Remember the collapsed choice per browser (read after mount to avoid a hydration mismatch).
  useEffect(() => { try { setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1"); } catch { /* storage blocked */ } }, []);
  const toggleCollapsed = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(SIDEBAR_KEY, n ? "1" : "0"); } catch { /* ignore */ } return n; });

  // `rail` = icon-only (desktop collapsed). `showToggle` adds the collapse control (desktop only).
  const sidebar = (rail: boolean, showToggle: boolean) => (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className={`mb-4 flex ${rail ? "flex-col items-center gap-2" : "items-center justify-between px-2"}`}>
        <Link href="/overview" onClick={() => setDrawer(false)} aria-label="Terrain — Overview">
          {rail ? <TerrainMark className="h-6" /> : <Wordmark size="text-xl" tone="cream" />}
        </Link>
        {showToggle && (
          <button onClick={toggleCollapsed} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={rail}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-cream/10 text-cream/45 transition hover:bg-cream/[0.04] hover:text-cream/80">
            <span className="text-base leading-none">{rail ? "»" : "«"}</span>
          </button>
        )}
      </div>
      {NAV.map((n) => {
        const active = isActive(pathname, n);
        if (n.children) {
          const expanded = open === n.label;
          if (rail) {
            return (
              <button key={n.label} title={n.label} aria-label={n.label}
                onClick={() => { toggleCollapsed(); setOpen(n.label); }}
                className={`flex w-full items-center justify-center rounded-xl p-2.5 transition ${active ? "bg-mint/15 text-mint" : "text-cream/60 hover:bg-cream/[0.04] hover:text-cream"}`}>
                {ICONS[n.label]}
              </button>
            );
          }
          return (
            <div key={n.label}>
              <button onClick={() => setOpen(expanded ? null : n.label)}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition ${active ? "text-cream" : "text-cream/65 hover:bg-cream/[0.04] hover:text-cream"}`}>
                <span className="flex items-center gap-2.5 font-medium"><span className={active ? "text-mint" : "text-cream/50"}>{ICONS[n.label]}</span>{n.label}</span>
                <span className={`text-cream/30 transition ${expanded ? "rotate-90" : ""}`}>›</span>
              </button>
              {expanded && (
                <div className="ml-[22px] mt-0.5 space-y-0.5 border-l border-cream/10 pl-3">
                  {n.children.map((c) => (
                    c.soon ? (
                      <div key={c.label} className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm text-cream/30">
                        {c.label} <span className="rounded-full border border-cream/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cream/40">Soon</span>
                      </div>
                    ) : (
                      <Link key={c.label} href={c.href!} onClick={() => setDrawer(false)}
                        className={`block rounded-lg px-3 py-1.5 text-sm transition ${isActive(pathname, c) ? "bg-mint/10 text-mint" : "text-cream/60 hover:bg-cream/[0.04] hover:text-cream"}`}>
                        {c.label}
                      </Link>
                    )
                  ))}
                </div>
              )}
            </div>
          );
        }
        return (
          <Link key={n.label} href={n.href!} onClick={() => setDrawer(false)} title={rail ? n.label : undefined} aria-label={n.label}
            className={`flex items-center rounded-xl transition ${rail ? "justify-center p-2.5" : "gap-2.5 px-3 py-2 text-sm font-medium"} ${active ? (rail ? "bg-mint/15 text-mint" : "bg-mint/12 text-cream") : "text-cream/65 hover:bg-cream/[0.04] hover:text-cream"}`}>
            <span className={rail ? "" : (active ? "text-mint" : "text-cream/50")}>{ICONS[n.label]}</span>{!rail && <span>{n.label}</span>}
          </Link>
        );
      })}
      {!rail && (
        <div className="mt-auto rounded-xl border border-cream/10 bg-cream/[0.02] p-3 text-xs text-cream/50">
          <div className="truncate font-medium text-cream/70">{user.workspace}</div>
          <div className="mt-0.5">{user.role}</div>
        </div>
      )}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-ink text-cream">
      {/* Sidebar (desktop) — full or icon rail */}
      <aside className={`hidden shrink-0 border-r border-cream/10 bg-ink-deep transition-[width] duration-200 md:block ${collapsed ? "w-[68px]" : "w-60"}`}>{sidebar(collapsed, true)}</aside>
      {/* Drawer (mobile) — always full */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-cream/10 bg-ink-deep">{sidebar(false, false)}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-cream/10 bg-ink/90 px-4 py-3 backdrop-blur md:px-6">
          <button onClick={() => setDrawer(true)} aria-label="Open navigation" className="rounded-lg border border-cream/15 px-2 py-1 text-cream/70 md:hidden">☰</button>
          <h1 className="font-display text-xl text-cream">{title}</h1>
          <div className="ml-auto flex items-center gap-2">
            {billing?.pastDue ? (
              <Link href="/billing" className="whitespace-nowrap rounded-full bg-orange px-3 py-1.5 text-sm font-medium text-cream transition hover:brightness-95">Payment failed — update card</Link>
            ) : billing?.trialDays != null ? (
              <Link href="/billing" className="whitespace-nowrap rounded-full bg-mint px-3 py-1.5 text-sm font-medium text-ink transition hover:brightness-95">{billing.trialDays} day{billing.trialDays === 1 ? "" : "s"} left · subscribe</Link>
            ) : null}
            <Link href="/support" className="hidden rounded-full border border-cream/15 px-3 py-1.5 text-sm text-cream/60 transition hover:text-cream sm:inline">Help</Link>
            <div className="relative">
              <button onClick={() => setMenu((v) => !v)} aria-label={`Open account menu for ${user.name}`} aria-expanded={menu}
                className="flex items-center gap-2 rounded-full border border-cream/15 py-1 pl-1 pr-2 transition hover:border-cream/40">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-orange text-sm font-semibold text-cream">{user.initials}</span>
                <span className="text-cream/50">▾</span>
              </button>
              {menu && <AccountMenu user={user} onClose={() => setMenu(false)} />}
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-6 md:py-8">{children}</main>
      </div>
    </div>
  );
}

function AccountMenu({ user, onClose }: { user: ShellUser; onClose: () => void }) {
  // Minimal, working menu for this increment (the full workspace/team/billing system is a separate build).
  // Every item here goes somewhere real; destinations that need backend aren't shown yet.
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 z-50 mt-2 w-64 rounded-2xl border border-cream/12 bg-ink-deep p-2 shadow-2xl" role="menu">
        <div className="border-b border-cream/10 px-3 py-2.5">
          <div className="truncate text-sm font-medium text-cream">{user.name}</div>
          <div className="truncate text-xs text-cream/45">{user.email}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-cream/60"><span className="h-1.5 w-1.5 rounded-full bg-mint" />{user.workspace} · {user.role}</div>
        </div>
        <MenuGroup label="Personal">
          <MenuLink href="/account">Account &amp; workspace</MenuLink>
          <MenuLink href="/digests">My digest subscriptions</MenuLink>
        </MenuGroup>
        <MenuGroup label="Workspace">
          <MenuLink href="/account">Team &amp; members</MenuLink>
          <MenuLink href="/billing">Billing &amp; plan</MenuLink>
        </MenuGroup>
        <MenuGroup label="Help">
          <MenuLink href="/support">Contact support</MenuLink>
        </MenuGroup>
        <div className="mt-1 border-t border-cream/10 pt-1">
          <form action="/api/auth/signout" method="post">
            <button type="submit" className="w-full rounded-lg px-3 py-2 text-left text-sm text-orange/90 transition hover:bg-orange/10" role="menuitem">Sign out</button>
          </form>
        </div>
      </div>
    </>
  );
}
function MenuGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-cream/30">{label}</div>
      {children}
    </div>
  );
}
function MenuLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="block rounded-lg px-3 py-2 text-sm text-cream/75 transition hover:bg-cream/[0.05] hover:text-cream" role="menuitem">{children}</Link>;
}
