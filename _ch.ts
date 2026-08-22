import { churnReport } from "./lib/churn";
async function main(){ const r = await churnReport();
  console.log("total:",r.total,"dead:",r.dead,"migrated:",r.migrated,"last30:",r.last30);
  console.log("migrated to:", r.byPlatform.slice(0,4).map(x=>`${x.label}(${x.count})`).join(", "));
  console.log("top categories:", r.byCategory.slice(0,4).map(x=>`${x.label}(${x.count})`).join(", "));
  console.log("payments known:", r.byPayment.slice(0,4).map(x=>`${x.label}(${x.count})`).join(", ") || "none yet");
  process.exit(0);}
main().catch(e=>{console.error("FAIL:",e.message);process.exit(1);});
