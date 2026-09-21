/** source-liveness — accurate liveness for imported Shopify leads via DNS (not homepage GETs,
 *  which JP/bot-protected sites block → false "dead"). "Still resolves to Shopify's /24" = live.
 *    node --env-file=.env.local scripts/source-liveness.mjs --source storecensus [--country JP]
 */
import postgres from "postgres";
import { promises as dns } from "dns";
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>=0&&process.argv[i+1]?process.argv[i+1]:d;};
const SRC=arg("--source","storecensus"), CTY=(arg("--country","")||"").toUpperCase();
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
  const rows=await sql`SELECT regexp_replace(domain,'^www\\.','') d, domain FROM imported_stores WHERE source=${SRC} ${cty}`;
  console.log(`source-liveness[${SRC}]: ${rows.length} stores (DNS)`);
  let a=0,m=0,x=0,done=0;
  await mapLimit(rows,40,async(r)=>{const st=await state(r.d);done++;st==="active"?a++:st==="migrated"?m++:x++;
    await sql`UPDATE imported_stores SET live_status=${st},live_checked_at=now() WHERE domain=${r.domain}`.catch(()=>{});});
  const t=rows.length||1;
  console.log(`live & still Shopify: ${a} (${Math.round(100*a/t)}%) · migrated: ${m} (${Math.round(100*m/t)}%) · dead: ${x} (${Math.round(100*x/t)}%)`);
} finally{await sql.end();}
