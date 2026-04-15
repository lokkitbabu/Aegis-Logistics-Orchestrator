"use client";
import { useReducer, useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type { WorldState, PlannerWeights, AIPResponse } from "@/lib/types";
import {
  buildDemoScenario, simulatorTick, runPlanningCycle,
  replanAll, injectThreatZone, injectGpsDenial, addUrgentTask,
  applyAIPResponse,
} from "@/lib/engine";
import { DEFAULT_WEIGHTS } from "@/lib/planner";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

type Action =
  | { type: "TICK" } | { type: "PLAN" } | { type: "THREAT" }
  | { type: "GPS" }  | { type: "URGENT" } | { type: "RESET" }
  | { type: "AIP_RESPONSE"; payload: AIPResponse };

interface AppState { world: WorldState; weights: PlannerWeights; lastAIP: AIPResponse | null; }

function reducer(state: AppState, action: Action): AppState {
  let world = state.world, weights = state.weights;
  switch (action.type) {
    case "TICK":   world = simulatorTick(world, weights); world = runPlanningCycle(world, weights); return { ...state, world };
    case "PLAN":   world = runPlanningCycle(world, weights); return { ...state, world };
    case "THREAT": world = injectThreatZone(world); world = replanAll(world, weights, "threat zone detected"); return { ...state, world };
    case "GPS":    world = injectGpsDenial(world); world = replanAll(world, weights, "GPS degraded"); return { ...state, world };
    case "URGENT": world = addUrgentTask(world); world = runPlanningCycle(world, weights); return { ...state, world };
    case "RESET":  return { world: buildDemoScenario(), weights: { ...DEFAULT_WEIGHTS }, lastAIP: null };
    case "AIP_RESPONSE": {
      let nw = weights;
      world = applyAIPResponse(world, action.payload, weights, w => { nw = w; });
      return { ...state, world, weights: nw, lastAIP: action.payload };
    }
    default: return state;
  }
}

const ASSET_COLORS: Record<string,string> = { D1:"#00e5ff", D2:"#ff44aa", G1:"#00ff88" };
const TASK_COLORS: Record<string,string> = {
  pending:"#f0a500", assigned:"#00e5ff", in_progress:"#00e5ff", complete:"#00ff88", failed:"#ff3040",
};

export default function Home() {
  const [state, dispatch] = useReducer(reducer, {
    world: buildDemoScenario(), weights: { ...DEFAULT_WEIGHTS }, lastAIP: null,
  });
  const [autoRun, setAutoRun]   = useState(false);
  const [aipInput, setAipInput] = useState("");
  const [aipLoading, setAipLoading] = useState(false);
  const autoRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const logRef  = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoRun) autoRef.current = setInterval(() => dispatch({type:"TICK"}), 500);
    else if (autoRef.current) clearInterval(autoRef.current);
    return () => { if (autoRef.current) clearInterval(autoRef.current); };
  }, [autoRun]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state.world.log]);

  const sendAIP = useCallback(async () => {
    if (!aipInput.trim() || aipLoading) return;
    setAipLoading(true);
    const ctx = {
      tick: state.world.tick,
      assets: Object.values(state.world.assets).map(a=>({id:a.id,type:a.type,battery:a.battery,pos:a.pos,status:a.status,currentTask:a.currentTask})),
      tasks:  Object.values(state.world.tasks).map(t=>({id:t.id,status:t.status,priority:t.priority,payloadKg:t.payloadKg,assignedTo:t.assignedAsset})),
      threatZones: state.world.zones.filter(z=>z.type==="threat").length,
      gpsDenied: state.world.gpsDenied.length > 0,
      plannerWeights: state.weights,
    };
    try {
      const res = await fetch("/api/aip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:aipInput,context:ctx})});
      dispatch({type:"AIP_RESPONSE",payload:await res.json()});
      setAipInput("");
    } finally { setAipLoading(false); }
  }, [aipInput, aipLoading, state]);

  const { world, weights, lastAIP } = state;
  const pending  = Object.values(world.tasks).filter(t=>t.status==="pending").length;
  const active   = Object.values(world.tasks).filter(t=>["assigned","in_progress"].includes(t.status)).length;
  const complete = Object.values(world.tasks).filter(t=>t.status==="complete").length;

  return (
    <div style={{position:"fixed",inset:0,overflow:"hidden",background:"#070a0d"}}>

      {/* Full-screen map */}
      <div style={{position:"absolute",inset:0}}>
        <MapView state={world} />
      </div>

      {/* Top HUD bar */}
      <div style={{
        position:"absolute",top:0,left:0,right:0,zIndex:100,
        background:"linear-gradient(180deg,rgba(4,8,12,0.96) 0%,rgba(4,8,12,0.6) 100%)",
        borderBottom:"1px solid rgba(0,200,255,0.15)",
        padding:"8px 16px",
        display:"flex",alignItems:"center",justifyContent:"space-between",
        backdropFilter:"blur(8px)",
      }}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          {/* Logo */}
          <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,fontWeight:700,color:"#00e5ff",letterSpacing:"0.3em"}}>
            ▣ AEGIS
          </div>
          <div style={{width:1,height:20,background:"rgba(0,200,255,0.2)"}}/>
          <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:"rgba(0,200,255,0.5)",letterSpacing:"0.2em"}}>
            LOGISTICS ORCHESTRATOR
          </div>
          <div style={{width:1,height:20,background:"rgba(0,200,255,0.2)"}}/>
          <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:"rgba(0,200,255,0.4)",letterSpacing:"0.15em"}}>
            AOR: NEVADA TEST & TRAINING RANGE
          </div>
        </div>

        {/* Mission stats */}
        <div style={{display:"flex",alignItems:"center",gap:20,fontFamily:"'Share Tech Mono',monospace",fontSize:10}}>
          <Stat label="TICK" value={String(world.tick).padStart(3,"0")} color="#00e5ff"/>
          <div style={{width:1,height:16,background:"rgba(0,200,255,0.15)"}}/>
          <Stat label="PENDING" value={String(pending)}  color="#f0a500"/>
          <Stat label="ACTIVE"  value={String(active)}   color="#00e5ff"/>
          <Stat label="COMPLETE" value={String(complete)} color="#00ff88"/>
          <div style={{width:1,height:16,background:"rgba(0,200,255,0.15)"}}/>
          {autoRun && <span style={{color:"#00ff88",fontSize:9}} className="blink">● LIVE</span>}
        </div>
      </div>

      {/* Left floating panel */}
      <div className="panel" style={{
        position:"absolute",left:12,top:56,bottom:12,width:170,zIndex:100,
        display:"flex",flexDirection:"column",overflow:"hidden",
        borderRadius:2,
      }}>
        <div className="panel-header">MISSION CTRL</div>
        <div style={{padding:"8px 8px 4px",display:"flex",flexDirection:"column",gap:4}}>
          <button className={`btn btn-primary ${autoRun?"blink":""}`} onClick={()=>setAutoRun(v=>!v)}>
            {autoRun?"⏸  PAUSE":"▶  AUTO-RUN"}
          </button>
          <button className="btn" onClick={()=>dispatch({type:"TICK"})}>▷  STEP TICK</button>
          <button className="btn" onClick={()=>dispatch({type:"PLAN"})}>↻  REPLAN NOW</button>
        </div>

        <div className="panel-header" style={{marginTop:4}}>INJECT EVENT</div>
        <div style={{padding:"8px 8px 4px",display:"flex",flexDirection:"column",gap:4}}>
          <button className="btn btn-alert" onClick={()=>dispatch({type:"THREAT"})}>⚡  THREAT ZONE</button>
          <button className="btn btn-alert" onClick={()=>dispatch({type:"GPS"})}>📡  GPS DEGRADE</button>
          <button className="btn" onClick={()=>dispatch({type:"URGENT"})}>🚨  URGENT TASK</button>
          <button className="btn" style={{marginTop:4,borderColor:"rgba(255,48,64,0.15)",color:"rgba(255,48,64,0.4)"}}
            onClick={()=>dispatch({type:"RESET"})}>⊗  RESET MISSION</button>
        </div>

        <div className="panel-header" style={{marginTop:4}}>ASSETS</div>
        <div style={{flex:1,overflowY:"auto",padding:"8px"}}>
          {Object.values(world.assets).map(a=>{
            const color=ASSET_COLORS[a.id]??"#fff";
            const bc=a.battery>40?"#00ff88":a.battery>15?"#f0a500":"#ff3040";
            return (
              <div key={a.id} style={{marginBottom:12,paddingBottom:8,borderBottom:"1px solid rgba(0,200,255,0.07)"}}>
                <div style={{color,fontFamily:"'Share Tech Mono',monospace",fontSize:10,marginBottom:3,display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontSize:12}}>{a.type==="drone"?"✦":"◈"}</span>
                  <span>{a.id}</span>
                  <span style={{color:"rgba(255,255,255,0.25)",fontSize:8}}>{a.type.toUpperCase()}</span>
                </div>
                <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"var(--text-dim)",lineHeight:1.8}}>
                  <div>({a.pos[0]}, {a.pos[1]}) · {a.status.toUpperCase()}</div>
                  <div>TASK: <span style={{color:a.currentTask?color:"rgba(255,255,255,0.2)"}}>{a.currentTask??"—"}</span></div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    BATT: <span style={{color:bc}}>{a.battery.toFixed(0)}%</span>
                  </div>
                </div>
                <div style={{height:2,background:"rgba(255,255,255,0.05)",marginTop:4,borderRadius:1}}>
                  <div style={{height:"100%",width:`${a.battery}%`,background:bc,borderRadius:1,transition:"width 0.4s"}}/>
                </div>
              </div>
            );
          })}
        </div>

        <div className="panel-header">WEIGHTS</div>
        <div style={{padding:"6px 8px",fontFamily:"'Share Tech Mono',monospace",fontSize:8}}>
          {Object.entries(weights).map(([k,v])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",color:"var(--text-dim)"}}>
              <span>{k.toUpperCase()}</span>
              <span style={{color:"var(--amber)"}}>{(v as number).toFixed(1)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right floating panel */}
      <div className="panel" style={{
        position:"absolute",right:12,top:56,bottom:12,width:255,zIndex:100,
        display:"flex",flexDirection:"column",overflow:"hidden",
        borderRadius:2,
      }}>
        {/* AIP */}
        <div className="panel-header">AIP COPILOT</div>
        <div style={{padding:"8px",borderBottom:"1px solid rgba(0,200,255,0.08)"}}>
          <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"var(--text-dim)",marginBottom:6,lineHeight:1.6}}>
            OPERATOR INTENT → CONSTRAINTS → LIVE REPLANNING
          </div>
          <textarea className="aip-input" rows={3}
            placeholder={"avoid risk zones\nprioritize fastest delivery"}
            value={aipInput}
            onChange={e=>setAipInput(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendAIP();}}}
          />
          <button className="btn btn-primary" style={{marginTop:4}} onClick={sendAIP} disabled={aipLoading}>
            {aipLoading?"⟳  PROCESSING...":"▶  SEND TO AIP"}
          </button>
          {lastAIP&&(
            <div style={{marginTop:8,padding:8,background:"rgba(0,10,6,0.8)",border:"1px solid rgba(0,255,136,0.12)",fontFamily:"'Share Tech Mono',monospace"}}>
              <div style={{color:"var(--amber)",fontSize:8,marginBottom:3,letterSpacing:"0.15em"}}>ACTION: {lastAIP.action.toUpperCase()}</div>
              <div style={{color:"rgba(0,255,136,0.7)",fontSize:9,lineHeight:1.6}}>{lastAIP.explanation}</div>
              {lastAIP.weights&&(
                <div style={{marginTop:4,color:"rgba(0,200,100,0.5)",fontSize:8,display:"flex",flexWrap:"wrap",gap:"4px 10px"}}>
                  {Object.entries(lastAIP.weights).map(([k,v])=>(
                    <span key={k}>{k}:{(v as number).toFixed(1)}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tasks */}
        <div className="panel-header">TASK BOARD</div>
        <div style={{padding:"6px 8px",borderBottom:"1px solid rgba(0,200,255,0.08)",maxHeight:130,overflowY:"auto"}}>
          {Object.values(world.tasks).map(t=>{
            const c=TASK_COLORS[t.status]??"#888";
            return (
              <div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"3px 0",borderBottom:"1px solid rgba(0,200,255,0.04)",fontFamily:"'Share Tech Mono',monospace",fontSize:9}}>
                <span style={{color:"var(--text)"}}>
                  {t.id} <span style={{color:"var(--text-dim)"}}>P{t.priority} {t.payloadKg}kg</span>
                </span>
                <span style={{color:c,fontSize:8}}>{t.status.toUpperCase()}</span>
              </div>
            );
          })}
        </div>

        {/* Log */}
        <div className="panel-header">DECISION FEED</div>
        <div ref={logRef} style={{flex:1,overflowY:"auto",padding:"6px 8px"}}>
          {world.log.length===0?(
            <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:"var(--text-dim)"}}>awaiting operations...</div>
          ):world.log.map((entry,i)=>{
            const m=entry.msg;
            const c=m.includes("⚠")||m.includes("🔋")?"rgba(240,165,0,0.7)":m.includes("✓")?"rgba(0,255,136,0.7)":m.includes("🚨")?"rgba(255,48,64,0.7)":m.includes("↺")||m.includes("📡")||m.includes("🎯")?"rgba(0,229,255,0.7)":"";
            return (
              <div key={i} className="log-line" style={{color:c||undefined}}>
                <span style={{color:"rgba(0,200,255,0.2)",marginRight:5}}>[{String(entry.tick).padStart(3,"0")}]</span>{m}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div style={{padding:"6px 8px",borderTop:"1px solid rgba(0,200,255,0.08)",fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"var(--text-dim)"}}>
          <div style={{display:"flex",flexWrap:"wrap",gap:"4px 10px"}}>
            <span><span style={{color:"#ff3040"}}>■</span> NO-GO</span>
            <span><span style={{color:"#ff6600"}}>■</span> THREAT</span>
            <span><span style={{color:"#8844ff"}}>■</span> GPS-DENY</span>
            <span><span style={{color:"#00e5ff"}}>✦</span> DRONE</span>
            <span><span style={{color:"#00ff88"}}>◈</span> GROUND</span>
          </div>
        </div>
      </div>

      {/* Bottom coord strip */}
      <div style={{
        position:"absolute",bottom:0,left:185,right:280,
        fontFamily:"'Share Tech Mono',monospace",fontSize:8,
        color:"rgba(0,200,255,0.3)",padding:"4px 12px",
        letterSpacing:"0.1em",zIndex:100,
        textAlign:"center",pointerEvents:"none",
      }}>
        37°N 116°W · NELLIS RANGE COMPLEX · UNCLASSIFIED // FOR DEMONSTRATION ONLY
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label:string; value:string; color:string }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
      <span style={{fontSize:7,color:"rgba(0,200,255,0.35)",letterSpacing:"0.2em"}}>{label}</span>
      <span style={{fontSize:13,color,fontFamily:"'Share Tech Mono',monospace"}}>{value}</span>
    </div>
  );
}
