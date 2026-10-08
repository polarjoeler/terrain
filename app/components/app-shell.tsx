"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/app/components/logo";

/** The authenticated application shell: labelled left sidebar + compact top bar + account menu.
 *  Server pages render their content as children; the (app) route-group layout supplies `user` and
 *  `billing`. Nav links point at real existing routes; not-yet-built destinations are marked "soon".
 *  Responsive: the sidebar collapses to a drawer on mobile. The page title is derived from the route
 *  (overridable), so individual pages don't each have to pass it. */

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
      { label: "Fraud Scanner", href: "/radar" },
      { label: "Store Groups", soon: true },
      { label: "Creator Leads", soon: true },
    ],
  },
  { label: "Digests", href: "/digests" },
];

// Route → page title. Longest matching prefix wins; falls back to the active nav label.
const TITLES: Record<string, string> = {
  "/overview": "Overview", "/dashboard": "Leads", "/lists": "Saved lists",
  "/insights": "Intelligence", "/partners": "Partner Finder", "/radar": "Fraud Scanner",
  "/digests": "Digests", "/account": "My profile",
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
  const activeSection = NAV.find((n) => n.children?.some((c) => isActive(pathname, c)))?.label;
  const [open, setOpen] = useState<string | null>(activeSection ?? "Discover");
  const title = pageTitle ?? titleFor(pathname);

  const Sidebar = (
    <nav className="flex h-full flex-col gap-1 p-4">
      <div className="mb-5 px-2"><Link href="/overview" onClick={() => setDrawer(false)}><Wordmark size="text-xl" tone="cream" /></Link></div>
      {NAV.map((n) => {
        const active = isActive(pathname, n);
        if (n.children) {
          const expanded = open === n.label;
          return (
            <div key={n.label}>
              <button onClick={() => setOpen(expanded ? null : n.label)}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition ${active ? "text-cream" : "text-cream/65 hover:bg-cream/[0.04] hover:text-cream"}`}>
                <span className="font-medium">{n.label}</span>
                <span className={`text-cream/30 transition ${expanded ? "rotate-90" : ""}`}>›</span>
              </button>
              {expanded && (
                <div className="ml-3 mt-0.5 space-y-0.5 border-l border-cream/10 pl-3">
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
          <Link key={n.label} href={n.href!} onClick={() => setDrawer(false)}
            className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${active ? "bg-mint/12 text-cream" : "text-cream/65 hover:bg-cream/[0.04] hover:text-cream"}`}>
            {active && <span className="h-4 w-0.5 rounded-full bg-mint" />}<span className={active ? "" : "ml-2.5"}>{n.label}</span>
          </Link>
        );
      })}
      <div className="mt-auto rounded-xl border border-cream/10 bg-cream/[0.02] p-3 text-xs text-cream/50">
        <div className="truncate font-medium text-cream/70">{user.workspace}</div>
        <div className="mt-0.5">{user.role}</div>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-ink text-cream">
      {/* Sidebar (desktop) */}
      <aside className="hidden w-60 shrink-0 border-r border-cream/10 bg-ink-deep md:block">{Sidebar}</aside>
      {/* Drawer (mobile) */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-cream/10 bg-ink-deep">{Sidebar}</aside>
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
          <MenuLink href="/account">My profile</MenuLink>
          <MenuLink href="/digests">My digest subscriptions</MenuLink>
        </MenuGroup>
        <MenuGroup label="Workspace">
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
