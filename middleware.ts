import { NextResponse, type NextRequest } from "next/server";

// Option A — geo-aware landing. A visitor Vercel places in Japan is sent from the Africa-focused
// homepage to the Japan map (/japan) on their first hit of "/" this session. We drop a session
// cookie so their subsequent "/" links (products, the #join newsletter, the wordmark) reach the
// real homepage instead of bouncing back — i.e. the redirect fires once, not on every click.
// "/?geo=off" is a permanent opt-out for a Japan-based visitor who actually wants the global site.
// Only "/" is matched (see config below); every other route — /japan, /africa, /insights… — is
// untouched. There is no geo header in local dev, so this no-ops locally.
export function middleware(req: NextRequest) {
  // Permanent opt-out: remember "show me the global site" and clean the query off the URL.
  if (req.nextUrl.searchParams.get("geo") === "off") {
    const to = req.nextUrl.clone();
    to.searchParams.delete("geo");
    const res = NextResponse.redirect(to);
    res.cookies.set("geo", "off", { path: "/", maxAge: 31_536_000, sameSite: "lax" }); // 1 year
    return res;
  }

  // Already routed this visitor (redirected once this session, or opted out) — leave them alone.
  if (req.cookies.get("geo")?.value) return NextResponse.next();

  // Vercel sets this at the edge (ISO-3166 alpha-2); absent in local dev.
  if (req.headers.get("x-vercel-ip-country") === "JP") {
    const res = NextResponse.redirect(new URL("/japan", req.url));
    res.cookies.set("geo", "jp", { path: "/", sameSite: "lax" }); // session cookie → re-shows next visit
    return res;
  }

  return NextResponse.next(); // everyone else: no cookie, no redirect
}

export const config = { matcher: "/" };
