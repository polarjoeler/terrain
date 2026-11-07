/** source-liveness — accurate liveness for imported Shopify leads via DNS (not homepage GETs,
 *  which JP/bot-protected sites block → false "dead"). "Still resolves to Shopify's /24" = live.
 *    node --env-file=.env.local scripts/source-liveness.mjs --source storecensus [--country JP]
 *    node --env-file=.env.local scripts/source-liveness.mjs --source storecensus --max-age 30
 *
 *  Scales to the whole table via three changes (added once the source grew past a million rows):
 *   - a STALENESS filter, so a re-run only touches rows never checked or checked long ago rather
 *     than redoing all of them;
 *   - KEYSET pagination, so it never loads the whole source into one array (at --source storecensus
 *     that would now be ~1.16M rows before any work starts);
 *   - BATCHED writes, grouped by status. One UPDATE per row would be one round trip per row —
 *     450k rows ≈ 2.5h of pure write latency against a pooler in another region.
 *  DNS is exempt from the shared Shopify-edge rate budget, so the resolve step can run wide; the
 *  `stillShopifyByHtml` tiebreak is a real HTTP fetch, but only fires for domains that resolve
 *  OFF Shopify's /24, which is a small minority.
 */
import postgres from "postgres";
import { promises as dns } from "dns";
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>=0&&process.argv[i+1]?process.argv[i+1]:d;};
const SRC=arg("--source","storecensus"), CTY=(arg("--country","")||"").toUpperCase();
const MAX_AGE=parseInt(arg("--max-age","30"),10);      // days; re-check anything older (0 = recheck all)
const BATCH=parseInt(arg("--batch","20000"),10);        // rows fetched per keyset page
const LIMIT=parseInt(arg("--limit","0"),10);            // 0 = no cap
const CONC=parseInt(arg("--concurrency","40"),10);
const UA="Mozilla/5.0 (compatible; terrain-radar/1.0)";
// A store that resolves but NOT to Shopify's /24 might have genuinely migrated OR just be
// Cloudflare-fronted Shopify (resolves to Cloudflare IPs). One homepage check settles it:
// cdn.shopify.com in the HTML → still Shopify (active), not a migration.
async function stillShopifyByHtml(d){
  for(const u of [`https://${d}/`,`https://www.${d}/`]){
    try{const c=new AbortController();const t=setTimeout(()=>c.abort(),9000);
      const r=await fetch(u,{signal:c.signal,redirect:"follow",headers:{"User-Agent":UA}});clearTimeout(t);
      if(r.ok){const h=(await r.text()).slice(0,120000).toLowerCase();return /cdn\.shopify\.com|myshopify|shopify\.theme|x-shopify/.test(h);}}catch{}}
  return false;
}
async function state(d){
  for(const h of [d,`www.${d}`]){try{if((await dns.resolve4(h)).some(i=>i.startsWith("23.227.38.")))return"active";}catch{}}
  for(const h of [d,`www.${d}`]){try{if((await dns.resolve4(h)).length){
    // resolves off the /24 — confirm it's a real migration, not Cloudflare-fronted Shopify
    return (await stillShopifyByHtml(d)) ? "active" : "migrated";
  }}catch{}}
  return"dead";}
async function mapLimit(items,n,fn){let i=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length)await fn(items[i++]);}));}
const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:4,idle_timeout:20});
try{
  const cty=CTY?sql`AND UPPER(country)=${CTY}`:sql``;
  const stale=MAX_AGE>0
    ? sql`AND (live_checked_at IS NULL OR live_checked_at < now() - (${MAX_AGE}||' days')::interval)`
    : sql``;
  let last="", total=0, a=0, m=0, x=0;
  for(;;){
    const rows=await sql`SELECT regexp_replace(domain,'^www\\.','') d, domain FROM imported_stores
      WHERE source=${SRC} AND domain > ${last} ${cty} ${stale}
      ORDER BY domain LIMIT ${BATCH}`;
    if(!rows.length) break;
    last=rows[rows.length-1].domain;
    // resolve wide, then write in three grouped statements instead of one per row
    const by={active:[],migrated:[],dead:[]};
    await mapLimit(rows,CONC,async(r)=>{ by[await state(r.d)].push(r.domain); });
    for(const [st,doms] of Object.entries(by)){
      if(!doms.length) continue;
      for(let i=0;i<doms.length;i+=5000)
        await sql`UPDATE imported_stores SET live_status=${st}, live_checked_at=now()
          WHERE domain = ANY(${doms.slice(i,i+5000)})`.catch(()=>{});
    }
    a+=by.active.length; m+=by.migrated.length; x+=by.dead.length; total+=rows.length;
    console.log(`  ${total.toLocaleString()} checked — active ${a.toLocaleString()} · migrated ${m.toLocaleString()} · dead ${x.toLocaleString()}`);
    if(LIMIT && total>=LIMIT) break;
  }
  const t=total||1;
  console.log(`source-liveness[${SRC}] done: ${total.toLocaleString()} stores`);
  console.log(`live & still Shopify: ${a} (${Math.round(100*a/t)}%) · migrated: ${m} (${Math.round(100*m/t)}%) · dead: ${x} (${Math.round(100*x/t)}%)`);
} finally{await sql.end();}
