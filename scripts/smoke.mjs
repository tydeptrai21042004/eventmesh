const A=process.env.A||"http://localhost:4001", B=process.env.B||"http://localhost:4002";
const j=async(u,o={})=>{const r=await fetch(u,{...o,headers:{"content-type":"application/json"}});const t=await r.text();if(!r.ok)throw new Error(`${r.status} ${t}`);return t?JSON.parse(t):{}};
const s=await j(`${A}/sessions`,{method:"POST",body:"{}"}); const id=s.session.sessionId; console.log("session",id);
const e1=await j(`${A}/sessions/${id}/events`,{method:"POST",body:JSON.stringify({type:"WORK_REQUEST",payload:{job:"smoke"}})}); await j(`${B}/sessions/${id}/events/${e1.eventHash}/ack`,{method:"POST",body:JSON.stringify({decision:"ACCEPT"})});
const e2=await j(`${B}/sessions/${id}/events`,{method:"POST",body:JSON.stringify({type:"WORK_RESULT",payload:{ok:true}})}); await j(`${A}/sessions/${id}/events/${e2.eventHash}/ack`,{method:"POST",body:JSON.stringify({decision:"ACCEPT"})});
const c=await j(`${A}/sessions/${id}/close`,{method:"POST",body:JSON.stringify({finalState:{ok:true}})}); console.log("closed",c.close.close.transcriptRoot);
const t=await j(`${A}/sessions/${id}/transcript`); await import("node:fs").then(fs=>fs.writeFileSync(`/tmp/${id}.json`,JSON.stringify(t,null,2))); console.log("transcript",`/tmp/${id}.json`);
