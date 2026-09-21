/** Liveness + still-Shopify check for the imported JP PDF leads — how good is this source? */
import postgres from "postgres";
const SRC=(process.argv.includes('--source')?process.argv[process.argv.indexOf('--source')+1]:'storecensus');
const UA="Mozilla/5.0 (compatible; terrain-radar/1.0; +liveness)";
async function get(u){const c=new AbortController();const t=setTimeout(()=>c.abort(),11000);
  try{return await fetch(u,{signal:c.signal,redirect:"follow",headers:{"User-Agent":UA}});}catch{return null;}finally{clearTimeout(t);}}
async function mapLimit(items,n,fn){let i=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length)await fn(items[i++]);}));}
const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:6,idle_timeout:20});
try{
  const rows=await sql`SELECT domain FROM imported_stores WHERE source=${SRC}`;
  console.log(`checking liveness of ${rows.length} PDF leads…`);
  let liveShop=0, aliveOther=0, dead=0, done=0;
  await mapLimit(rows,14,async({domain})=>{
    let html=null,ok=false;
    for(const u of [`https://${domain}/`,`https://www.${domain}/`]){const r=await get(u);if(r&&r.ok){ok=true;html=(await r.text().catch(()=>"")).slice(0,200000);break;}if(r===null)break;}
    let status;
    if(!ok){dead++;status="dead";}
    else if(html&&/cdn\.shopify\.com|myshopify\.com|shopify\.theme|x-shopify/i.test(html)){liveShop++;status="active";}
    else {aliveOther++;status="migrated";} // alive but no Shopify marker → left Shopify
    done++;
    await sql`UPDATE imported_stores SET live_status=${status}, live_checked_at=now() WHERE domain=${domain}`.catch(()=>{});
    if(done%150===0)process.stdout.write(`\r  ${done}/${rows.length}`);
  });
  const tot=rows.length;
  console.log(`\n\nLIVENESS of this source (${tot} leads):`);
  console.log(`  live & still Shopify: ${liveShop} (${Math.round(100*liveShop/tot)}%)`);
  console.log(`  alive but left Shopify (migrated): ${aliveOther} (${Math.round(100*aliveOther/tot)}%)`);
  console.log(`  dead / unreachable: ${dead} (${Math.round(100*dead/tot)}%)`);
} finally{await sql.end();}
