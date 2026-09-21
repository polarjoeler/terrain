#!/usr/bin/env python3
"""
parse-leads-pdf — turn StoreLeads-style "Lead Dashboard" PDF exports into JSON rows for import.
Reads the "Active Filters" header (Platform / Country) so each file is tagged correctly, and
extracts one row per store (domain + estimated monthly sales). Lossy by nature (apps/theme are
messy free-text in a PDF) — domain + platform + country + sales are what we keep.

    python3 scripts/parse-leads-pdf.py "/path/one.pdf" "/path/two.pdf" > rows.json
"""
import sys, re, json
import pypdf

COUNTRY_ISO = {"japan": "JP", "south africa": "ZA", "kenya": "KE", "nigeria": "NG", "united states": "US",
               "united kingdom": "GB", "australia": "AU", "canada": "CA", "germany": "DE", "france": "FR"}

def parse(path):
    r = pypdf.PdfReader(path)
    text = "\n".join((p.extract_text() or "") for p in r.pages)
    plat = (re.search(r"Platform:\s*([A-Za-z0-9 ]+)", text) or [None, "Shopify"])[1].strip()
    cty = (re.search(r"Country:\s*([A-Za-z ]+?)(?:\s|$)", text) or [None, ""])[1].strip()
    iso = COUNTRY_ISO.get(cty.lower())
    out = {}
    for line in text.split("\n"):
        line = line.strip()
        m = re.match(r"^([a-z0-9][a-z0-9.\-]+\.[a-z]{2,})\s", line, re.I)
        if not m:
            continue
        d = m.group(1).lower()
        if d in ("page", "results", "search", "export", "next", "previous"):
            continue
        sales = re.search(r"\$([\d,]+)\.\d{2}", line)
        out[d] = {"domain": d, "platform": plat, "country": iso,
                  "sales": int(sales.group(1).replace(",", "")) if sales else None}
    return out

def main():
    files = sys.argv[1:]
    if not files:
        print("usage: parse-leads-pdf.py <pdf> [<pdf> …] > rows.json", file=sys.stderr); return 2
    rows = {}
    for f in files:
        got = parse(f)
        rows.update(got)
        print(f"{f.split('/')[-1]}: {len(got)} rows", file=sys.stderr)
    print(f"total unique: {len(rows)}", file=sys.stderr)
    json.dump(list(rows.values()), sys.stdout)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
