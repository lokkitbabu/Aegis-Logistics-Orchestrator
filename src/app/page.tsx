"use client";
import { useReducer, useEffect, useRef, useState, useCallback } from "react";
import MapView from "@/components/MapView";
import type { WorldState, PlannerWeights, AIPResponse } from "@/lib/types";
import {
  buildDemoScenario, simulatorTick, runPlanningCycle,
  replanAll, injectThreatZone, injectGpsDenial, addUrgentTask,
  applyAIPResponse,
} from "@/lib/engine";
import { DEFAULT_WEIGHTS } from "@/lib/planner";

type Action =
  | { type: "TICK" }
  | { type: "PLAN" }
  | { type: "THREAT" }
  | { type: "GPS" }
  | { type: "URGENT" }
  | { type: "RESET" }
  | { type: "AIP_RESPONSE"; payload: AIPResponse };

interface AppState {
  world: WorldState;
  weights: PlannerWeights;
  lastAIP: AIPResponse | null;
}

function reducer(state: AppState, action: Action): AppState {
  let world = state.world;
  let weights = state.weights;
  switch (action.type) {
    case "TICK":
      world = simulatorTick(world, weights);
      world = runPlanningCycle(world, weights);
      return { ...state, world };
    case "PLAN":
      world = runPlanningCycle(world, weights);
      return { ...state, world };
    case "THREAT":
      world = injectThreatZone(world);
      world = replanAll(world, weights, "threat zone detected");
      return { ...state, world };
    case "GPS":
      world = injectGpsDenial(world);
      world = replanAll(world, weights, "GPS degraded");
      return { ...state, world };
    case "URGENT":
      world = addUrgentTask(world);
      world = runPlanningCycle(world, weights);
      return { ...state, world };
    case "RESET":
      return { world: buildDemoScenario(), weights: { ...DEFAULT_WEIGHTS }, lastAIP: null };
    case "AIP_RESPONSE": {
      let newWeights = weights;
      world = applyAIPResponse(world, action.payload, weights, (w) => { newWeights = w; });
      return { ...state, world, weights: newWeights, lastAIP: action.payload };
    }
    default: return state;
  }
}

const ASSET_COLORS: Record<string, string> = { D1:"#38bdf8", D2:"#f472b6", G1:"#4ade80" };
const STATUS_COLORS: Record<string, string> = {
  pending:"#e8a020", assigned:"#38bdf8", in_progress:"#38bdf8",
  complete:"#22c55e", failed:"#ef4444",
};

export default function Home() {
  const [state, dispatch] = useReducer(reducer, {
    world: buildDemoScenario(),
    weights: { ...DEFAULT_WEIGHTS },
    lastAIP: null,
  });
  const [autoRun, setAutoRun] = useState(false);
  const [aipInput, setAipInput] = useState("");
  const [aipLoading, setAipLoading] = useState(false);
  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoRun) {
      autoRef.current = setInterval(() => dispatch({ type: "TICK" }), 400);
    } else {
      if (autoRef.current) clearInterval(autoRef.current);
    }
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
      assets: Object.values(state.world.assets).map(a => ({
        id:a.id, type:a.type, battery:a.battery, pos:a.pos, status:a.status, currentTask:a.currentTask
      })),
      tasks: Object.values(state.world.tasks).map(t => ({
        id:t.id, status:t.status, priority:t.priority, payloadKg:t.payloadKg, assignedTo:t.assignedAsset
      })),
      threatZones: state.world.zones.filter(z=>z.type==="threat").length,
      gpsDenied: state.world.gpsDenied.length > 0,
      plannerWeights: state.weights,
    };
    try {
      const res = await fetch("/api/aip", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ message: aipInput, context: ctx }),
      });
      const data: AIPResponse = await res.json();
      dispatch({ type: "AIP_RESPONSE", payload: data });
      setAipInput("");
    } finally {
      setAipLoading(false);
    }
  }, [aipInput, aipLoading, state]);

  const { world, weights, lastAIP } = state;
  const pendingCount = Object.values(world.tasks).filter(t=>t.status==="pending").length;
  const activeCount  = Object.values(world.tasks).filter(t=>t.status==="assigned").length;
  const doneCount    = Object.values(world.tasks).filter(t=>t.status==="complete").length;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden" style={{background:"var(--bg)"}}>
      {/* Topbar */}
      <div className="flex items-center justify-between px-4 py-2"
           style={{borderBottom:"1px solid var(--border)", background:"var(--surface)", flexShrink:0}}>
        <div className="flex items-center gap-4">
          <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:13,color:"var(--amber)",letterSpacing:"0.2em"}}>▣ AEGIS</span>
          <span style={{fontSize:9,color:"var(--text-dim)",letterSpacing:"0.15em"}}>LOGISTICS ORCHESTRATOR // CONTESTED ENV</span>
        </div>
        <div className="flex items-center gap-6" style={{fontSize:10,fontFamily:"'Share Tech Mono',monospace"}}>
          <span style={{color:"var(--text-dim)"}}>T=<span style={{color:"var(--amber)"}}>{String(world.tick).padStart(3,"0")}</span></span>
          <span style={{color:"var(--text-dim)"}}>PENDING=<span style={{color:"#e8a020"}}>{pendingCount}</span></span>
          <span style={{color:"var(--text-dim)"}}>ACTIVE=<span style={{color:"#38bdf8"}}>{activeCount}</span></span>
          <span style={{color:"var(--text-dim)"}}>DONE=<span style={{color:"#22c55e"}}>{doneCount}</span></span>
          {autoRun && <span style={{color:"#22c55e"}} className="pulse">● LIVE</span>}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* LEFT */}
        <div className="panel flex flex-col" style={{width:175,flexShrink:0,borderTop:"none",borderLeft:"none",borderBottom:"none",overflowY:"auto"}}>
          <div className="panel-header">MISSION CONTROLS</div>
          <div className="flex flex-col gap-1 p-2">
            <button className={`btn btn-primary ${autoRun?"pulse":""}`} onClick={()=>setAutoRun(v=>!v)}>
              {autoRun?"⏸ PAUSE":"▶ AUTO-RUN"}
            </button>
            <button className="btn" onClick={()=>dispatch({type:"TICK"})}>▷ STEP TICK</button>
            <button className="btn" onClick={()=>dispatch({type:"PLAN"})}>↻ REPLAN</button>
          </div>
          <div className="panel-header mt-1">INJECT EVENT</div>
          <div className="flex flex-col gap-1 p-2">
            <button className="btn btn-danger" onClick={()=>dispatch({type:"THREAT"})}>⚡ THREAT ZONE</button>
            <button className="btn btn-danger" onClick={()=>dispatch({type:"GPS"})}>📡 GPS DEGRADE</button>
            <button className="btn" onClick={()=>dispatch({type:"URGENT"})}>🚨 URGENT TASK</button>
            <button className="btn" style={{marginTop:6,borderColor:"#1a1010"}} onClick={()=>dispatch({type:"RESET"})}>⊗ RESET</button>
          </div>
          <div className="panel-header mt-1">ASSETS</div>
          <div className="flex-1 p-2" style={{fontSize:10}}>
            {Object.values(world.assets).map(a=>{
              const color=ASSET_COLORS[a.id]??"#fff";
              const bc=a.battery>40?"#22c55e":a.battery>15?"#e8a020":"#ef4444";
              return (
                <div key={a.id} className="mb-3 pb-2" style={{borderBottom:"1px solid var(--border)"}}>
                  <div style={{color,fontFamily:"'Share Tech Mono',monospace",fontSize:11,marginBottom:2}}>
                    {a.type==="drone"?"✦":"◈"} {a.id}
                  </div>
                  <div style={{color:"var(--text-dim)",lineHeight:1.7}}>
                    <div>({a.pos[0]},{a.pos[1]}) {a.status.toUpperCase()}</div>
                    <div>BATT <span style={{color:bc}}>{a.battery.toFixed(0)}%</span> | {a.currentTask??"IDLE"}</div>
                  </div>
                  <div style={{height:2,background:"#1e2830",marginTop:3,borderRadius:1}}>
                    <div style={{height:"100%",width:`${a.battery}%`,background:bc,borderRadius:1,transition:"width 0.3s"}}/>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="panel-header">PLANNER WEIGHTS</div>
          <div className="p-2" style={{fontSize:9,color:"var(--text-dim)",fontFamily:"'Share Tech Mono',monospace"}}>
            {Object.entries(weights).map(([k,v])=>(
              <div key={k} className="flex justify-between py-0.5">
                <span>{k.toUpperCase()}</span>
                <span style={{color:"var(--amber)"}}>{(v as number).toFixed(1)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* CENTER */}
        <div className="flex-1 overflow-hidden" style={{borderLeft:"1px solid var(--border)"}}>
          <MapView state={world}/>
        </div>

        {/* RIGHT */}
        <div className="panel flex flex-col" style={{width:255,flexShrink:0,borderTop:"none",borderRight:"none",borderBottom:"none"}}>
          <div className="panel-header">AIP COPILOT</div>
          <div className="p-2" style={{borderBottom:"1px solid var(--border)"}}>
            <div style={{fontSize:9,color:"var(--text-dim)",marginBottom:6,fontFamily:"'Share Tech Mono',monospace",lineHeight:1.6}}>
              operator intent → structured constraints → live replanning
            </div>
            <textarea className="aip-input" rows={3}
              placeholder={"e.g. avoid risk zones\nprioritize fastest delivery"}
              value={aipInput}
              onChange={e=>setAipInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendAIP();}}}
            />
            <button className="btn btn-primary" style={{marginTop:4}} onClick={sendAIP} disabled={aipLoading}>
              {aipLoading?"⟳ PROCESSING...":"▶ SEND TO AIP"}
            </button>
            {lastAIP&&(
              <div style={{marginTop:8,padding:8,background:"#040c06",border:"1px solid #142018",fontSize:9,fontFamily:"'Share Tech Mono',monospace"}}>
                <div style={{color:"var(--amber)",marginBottom:3}}>ACTION: {lastAIP.action.toUpperCase()}</div>
                <div style={{color:"#7aaa80",lineHeight:1.5}}>{lastAIP.explanation}</div>
                {lastAIP.weights&&(
                  <div style={{marginTop:4,color:"#3a7a48"}}>
                    {Object.entries(lastAIP.weights).map(([k,v])=>(
                      <span key={k} style={{marginRight:8}}>{k}:{(v as number).toFixed(1)}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="panel-header">TASK BOARD</div>
          <div className="p-2" style={{borderBottom:"1px solid var(--border)",maxHeight:130,overflowY:"auto"}}>
            {Object.values(world.tasks).map(t=>{
              const c=STATUS_COLORS[t.status]??"#888";
              return (
                <div key={t.id} className="flex justify-between py-1"
                     style={{borderBottom:"1px solid #0c150e",fontSize:9,fontFamily:"'Share Tech Mono',monospace"}}>
                  <span style={{color:"var(--text)"}}>{t.id} <span style={{color:"var(--text-dim)"}}>P{t.priority} {t.payloadKg}kg</span></span>
                  <span style={{color:c}}>{t.status.toUpperCase()}</span>
                </div>
              );
            })}
          </div>

          <div className="panel-header">DECISION FEED</div>
          <div ref={logRef} className="flex-1 overflow-y-auto p-2">
            {world.log.length===0?(
              <div style={{color:"var(--text-dim)",fontFamily:"'Share Tech Mono',monospace",fontSize:9}}>awaiting operations...</div>
            ):world.log.map((entry,i)=>{
              const m=entry.msg;
              const c=m.includes("⚠")||m.includes("🔋")?"#e8a02088":m.includes("✓")?"#22c55e88":m.includes("🚨")||m.includes("🔴")?"#ef444488":m.includes("↺")||m.includes("📡")||m.includes("🎯")?"#38bdf888":"";
              return (
                <div key={i} className="log-line" style={{color:c||undefined}}>
                  <span style={{color:"#1a2a1a",marginRight:4}}>[{String(entry.tick).padStart(3,"0")}]</span>{m}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
