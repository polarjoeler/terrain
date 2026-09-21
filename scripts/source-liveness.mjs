/** source-liveness — accurate liveness for imported Shopify leads via DNS (not homepage GETs,
 *  which JP/bot-protected sites block → false "dead"). "Still resolves to Shopify's /24" = live.
 *    node --env-file=.env.local scripts/source-liveness.mjs --source storecensus [--country JP]
 */
import postgres from "postgres";
import { promises as dns } from "dns";
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>=0&&process.argv[i+1]?process.argv[i+1]:d;};
const SRC=arg("--source","storecensus"), CTY=(arg("--country","")||"").toUpperCase();
async function state(d){for(const h of [d,`www.${d}`]){try{if((await dns.resolve4(h)).some(i=>i.startsWith("23.227.38.")))return"active";}catch{}}
  for(const h of [d,`www.${d}`]){try{if((await dns.resolve4(h)).length)return"migrated";}catch{}}return"dead";}
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
