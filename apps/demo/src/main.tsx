import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const A = import.meta.env.VITE_OPERATOR_A_URL ?? "http://localhost:4001";
const B = import.meta.env.VITE_OPERATOR_B_URL ?? "http://localhost:4002";
async function api(url:string, options?:RequestInit){ const r=await fetch(url,{...options,headers:{"content-type":"application/json",...(options?.headers||{})}}); const t=await r.text(); const j=t?JSON.parse(t):{}; if(!r.ok) throw new Error(j.detail||j.error||t); return j; }

function App(){
  const [health,setHealth]=useState<any>({}); const [sessionId,setSessionId]=useState(""); const [state,setState]=useState<any>(); const [type,setType]=useState("WORK_REQUEST"); const [payload,setPayload]=useState('{"job":"demo-001"}'); const [sender,setSender]=useState<"A"|"B">("A"); const [error,setError]=useState("");
  const refresh=async(id=sessionId)=>{ if(!id)return; try{setState(await api(`${A}/sessions/${id}`));}catch(e:any){setError(e.message)} };
  useEffect(()=>{Promise.all([api(`${A}/health`),api(`${B}/health`)]).then(([a,b])=>setHealth({a,b})).catch(e=>setError(e.message));},[]);
  useEffect(()=>{if(!sessionId)return; const t=setInterval(()=>refresh(),1500); return()=>clearInterval(t)},[sessionId]);
  const create=async()=>{try{setError("");const s=await api(`${A}/sessions`,{method:"POST",body:"{}"});setSessionId(s.session.sessionId); await refresh(s.session.sessionId);}catch(e:any){setError(e.message)}};
  const send=async()=>{try{setError("");const base=sender==="A"?A:B;await api(`${base}/sessions/${sessionId}/events`,{method:"POST",body:JSON.stringify({type,payload:JSON.parse(payload)})});await refresh();}catch(e:any){setError(e.message)}};
  const ack=async(ev:any)=>{try{setError("");const base=ev.sender===health.a?.publicKey?B:A;await api(`${base}/sessions/${sessionId}/events/${ev.eventHash}/ack`,{method:"POST",body:JSON.stringify({decision:"ACCEPT"})});await refresh();}catch(e:any){setError(e.message)}};
  const close=async()=>{try{setError("");await api(`${A}/sessions/${sessionId}/close`,{method:"POST",body:JSON.stringify({finalState:{demo:"complete"}})});await refresh();}catch(e:any){setError(e.message)}};
  const download=async()=>{const t=await api(`${A}/sessions/${sessionId}/transcript`);const blob=new Blob([JSON.stringify(t,null,2)],{type:"application/json"});const u=URL.createObjectURL(blob);const a=document.createElement("a");a.href=u;a.download=`${sessionId}.json`;a.click();URL.revokeObjectURL(u)};
  return <main><header><div><div className="eyebrow">CKB + Fiber · cross-operator sessions</div><h1>EventMesh <span>v0.1</span></h1><p>Two independent operator stores. Signed, ordered events. Mutual ACKs. Optional Fiber payment and CKB final anchor.</p></div><button onClick={create}>Create session</button></header>
    {error&&<div className="error">{error}</div>}
    <section className="operators"><Card title="Operator A" h={health.a}/><Card title="Operator B" h={health.b}/></section>
    {!sessionId?<section className="empty">Create a session to begin.</section>:<>
      <section className="session"><div><b>{sessionId}</b><small>{state?.status||"loading"}</small></div><div className="root">{state?.close?.close?.transcriptRoot||"Transcript root appears after close"}</div></section>
      <section className="compose"><select value={sender} onChange={e=>setSender(e.target.value as any)}><option value="A">Operator A sends</option><option value="B">Operator B sends</option></select><input value={type} onChange={e=>setType(e.target.value)} placeholder="EVENT_TYPE"/><input value={payload} onChange={e=>setPayload(e.target.value)} placeholder='{"key":"value"}'/><button onClick={send} disabled={state?.status==="CLOSED"}>Send signed event</button></section>
      <section className="timeline">{state?.events?.length?state.events.map((row:any)=><article key={row.event.eventHash}><div className="seq">#{row.event.sequence}</div><div className="event"><b>{row.event.type}</b><code>{JSON.stringify(row.event.payload)}</code><small>{row.event.sender===health.a?.publicKey?"A":"B"} · {row.event.eventHash.slice(0,18)}…</small></div><div className={`status ${row.status.toLowerCase()}`}>{row.status}</div>{row.status==="PROPOSED"&&<button onClick={()=>ack(row.event)}>ACK</button>}</article>):<div className="empty">No events yet.</div>}</section>
      <section className="actions"><button onClick={close} disabled={state?.status==="CLOSED"}>Close session</button><button className="secondary" onClick={download}>Export transcript</button>{state?.anchor&&<span>CKB: {state.anchor.txHash.slice(0,20)}…</span>}</section>
    </>}
  </main>
}
function Card({title,h}:{title:string,h:any}){return <div className="card"><div><span className={h?.status==="ok"?"dot on":"dot"}/>{title}</div><code>{h?.publicKey?h.publicKey.slice(0,28)+"…":"offline"}</code><small>Fiber {h?.fiberEnabled?"ON":"OFF"} · CKB {h?.ckbEnabled?"ON":"OFF"}</small></div>}
createRoot(document.getElementById("root")!).render(<App/>);
