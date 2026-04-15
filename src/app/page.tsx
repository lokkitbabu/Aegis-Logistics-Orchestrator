"use client";
import { useReducer, useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type { WorldState, PlannerWeights, AIPResponse, Task, CargoType } from "@/lib/types";
import { CARGO_COLOR, CARGO_PRIORITY, DEFAULT_WEIGHTS } from "@/lib/types";
import {
  buildDemoScenario, simulatorTick, runPlanningCycle, replanAll,
  injectThreatZone, injectGpsDenial, addUrgentTask, deteriorateWeather,
  approveTask, cancelTask, applyAIPResponse,
} from "@/lib/engine";

const MapView = dynamic(() => import("@/components/MapView"), { ssr:false });

type Action =
  | {type:"TICK"} | {type:"PLAN"} | {type:"THREAT"} | {type:"GPS"}
  | {type:"URGENT"} | {type:"RESET"} | {type:"WEATHER"}
  | {type:"APPROVE"; taskId:string} | {type:"CANCEL"; taskId:string}
  | {type:"AIP"; payload:AIPResponse};

interface AppState { world:WorldState; weights:PlannerWeights; lastAIP:AIPResponse|null; }

function reducer(s: AppState, a: Action): AppState {
  let w=s.world, wt=s.weights;
  switch(a.type) {
    case "TICK":    w=simulatorTick(w,wt); w=runPlanningCycle(w,wt); return {...s,world:w};
    case "PLAN":    w=runPlanningCycle(w,wt); return {...s,world:w};
    case "THREAT":  w=injectThreatZone(w); w=replanAll(w,wt,"threat zone"); return {...s,world:w};
    case "GPS":     w=injectGpsDenial(w); w=replanAll(w,wt,"GPS degraded"); return {...s,world:w};
    case "URGENT":  w=addUrgentTask(w); w=runPlanningCycle(w,wt); return {...s,world:w};
    case "WEATHER": w=deteriorateWeather(w); return {...s,world:w};
    case "RESET":   return {world:buildDemoScenario(),weights:{...DEFAULT_WEIGHTS},lastAIP:null};
    case "APPROVE": w=approveTask(w,a.taskId); w=runPlanningCycle(w,wt); return {...s,world:w};
    case "CANCEL":  w=cancelTask(w,a.taskId,wt); return {...s,world:w};
    case "AIP": {
      let nw=wt;
      w=applyAIPResponse(w,a.payload,wt,x=>{nw=x;});
      return {...s,world:w,weights:nw,lastAIP:a.payload};
    }
    default: return s;
  }
}

const ASSET_COLORS: Record<string,string> = {D1:"#00e5ff",D2:"#ff44aa",G1:"#00ff88"};
const TASK_STATUS_COLOR: Record<string,string> = {
  pending:"#f0a500",approved:"#00e5ff",assigned:"#44aaff",
  in_progress:"#44aaff",complete:"#00ff88",failed:"#ff3040",cancelled:"#444",
};

type RightTab = "aip"|"supply"|"missions";

export default function Home() {
  const [state,dispatch] = useReducer(reducer,{world:buildDemoScenario(),weights:{...DEFAULT_WEIGHTS},lastAIP:null});
  const [autoRun,setAutoRun]   = useState(false);
  const [aipInput,setAipInput] = useState("");
  const [aipLoading,setAipLoading] = useState(false);
  const [rightTab,setRightTab] = useState<RightTab>("missions");
  const [showRanges,setShowRanges] = useState(false);
  const autoRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const logRef  = useRef<HTMLDivElement>(null);

  useEffect(()=>{
    if(autoRun) autoRef.current=setInterval(()=>dispatch({type:"TICK"}),500);
    else if(autoRef.current) clearInterval(autoRef.current);
    return ()=>{if(autoRef.current)clearInterval(autoRef.current);};
  },[autoRun]);

  useEffect(()=>{ if(logRef.current) logRef.current.scrollTop=logRef.current.scrollHeight; },[state.world.log]);

  const sendAIP = useCallback(async()=>{
    if(!aipInput.trim()||aipLoading) return;
    setAipLoading(true);
    const ctx = {
      tick:state.world.tick,
      assets:Object.values(state.world.assets).map(a=>({id:a.id,type:a.type,battery:a.battery,status:a.status,currentTask:a.currentTask,pos:a.pos,cargo:a.cargo})),
      tasks:Object.values(state.world.tasks).filter(t=>!["complete","cancelled"].includes(t.status)).map(t=>({id:t.id,status:t.status,priority:t.priority,cargo:t.cargo,sourceNodeId:t.sourceNodeId,destNodeId:t.destNodeId,riskScore:t.riskScore})),
      nodes:Object.values(state.world.nodes).map(n=>({id:n.id,name:n.name,type:n.type,inventory:n.inventory})),
      weather:state.world.weather,
      threatZones:state.world.zones.filter(z=>z.type==="threat").length,
      gpsDenied:state.world.gpsDenied.length>0,
      plannerWeights:state.weights,
    };
    try {
      const res=await fetch("/api/aip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:aipInput,context:ctx})});
      dispatch({type:"AIP",payload:await res.json()});
      setAipInput("");
    } finally { setAipLoading(false); }
  },[aipInput,aipLoading,state]);

  const {world,weights,lastAIP} = state;
  const activeTasks  = Object.values(world.tasks).filter(t=>["assigned","in_progress"].includes(t.status));
  const pendingTasks = Object.values(world.tasks).filter(t=>t.status==="pending");
  const approvedTasks= Object.values(world.tasks).filter(t=>t.status==="approved");
  const doneTasks    = Object.values(world.tasks).filter(t=>t.status==="complete");

  return (
    <div style={{position:"fixed",inset:0,overflow:"hidden",background:"#040810"}}>
      {/* Map full screen */}
      <div style={{position:"absolute",inset:0}}>
        <MapView state={world} showRanges={showRanges}/>
      </div>

      {/* ── TOP HUD ─────────────────────────────────────────────── */}
      <div style={{position:"absolute",top:0,left:0,right:0,zIndex:100,
        background:"linear-gradient(180deg,rgba(2,6,12,0.97) 0%,rgba(2,6,12,0.5) 100%)",
        borderBottom:"1px solid rgba(0,200,255,0.12)",padding:"7px 16px",
        display:"flex",alignItems:"center",justifyContent:"space-between",backdropFilter:"blur(8px)"}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:15,fontWeight:700,color:"#00e5ff",letterSpacing:"0.3em"}}>▣ AEGIS</span>
          <div style={{width:1,height:18,background:"rgba(0,200,255,0.18)"}}/>
          <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(0,200,255,0.45)",letterSpacing:"0.2em"}}>LOGISTICS ORCHESTRATOR</span>
          <div style={{width:1,height:18,background:"rgba(0,200,255,0.18)"}}/>
          <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(0,200,255,0.35)",letterSpacing:"0.12em"}}>AOR: NEVADA TEST & TRAINING RANGE · 37°N 116°W</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:16,fontFamily:"'Share Tech Mono',monospace"}}>
          <HudStat label="TICK"     value={String(world.tick).padStart(3,"0")} color="#00e5ff"/>
          <HudStat label="PENDING"  value={String(pendingTasks.length)}  color="#f0a500"/>
          <HudStat label="QUEUED"   value={String(approvedTasks.length)} color="#00e5ff"/>
          <HudStat label="ACTIVE"   value={String(activeTasks.length)}   color="#44aaff"/>
          <HudStat label="COMPLETE" value={String(doneTasks.length)}      color="#00ff88"/>
          <div style={{width:1,height:16,background:"rgba(0,200,255,0.12)"}}/>
          <div style={{display:"flex",gap:6,fontSize:9}}>
            <ToggleBtn active={showRanges} onClick={()=>setShowRanges(v=>!v)} label="RANGES"/>
          </div>
          {autoRun&&<span style={{color:"#00ff88",fontSize:9,fontFamily:"'Share Tech Mono',monospace"}} className="blink">● LIVE</span>}
        </div>
      </div>

      {/* ── LEFT PANEL ──────────────────────────────────────────── */}
      <div className="panel" style={{position:"absolute",left:10,top:50,bottom:10,width:172,zIndex:100,display:"flex",flexDirection:"column",borderRadius:2,overflow:"hidden"}}>
        <div className="panel-header">MISSION CONTROLS</div>
        <div style={{padding:"8px 8px 4px",display:"flex",flexDirection:"column",gap:3}}>
          <button className={`btn btn-primary ${autoRun?"blink":""}`} onClick={()=>setAutoRun(v=>!v)}>{autoRun?"⏸  PAUSE":"▶  AUTO-RUN"}</button>
          <button className="btn" onClick={()=>dispatch({type:"TICK"})}>▷  STEP TICK</button>
          <button className="btn" onClick={()=>dispatch({type:"PLAN"})}>↻  REPLAN NOW</button>
        </div>

        <div className="panel-header" style={{marginTop:4}}>INJECT EVENT</div>
        <div style={{padding:"8px 8px 4px",display:"flex",flexDirection:"column",gap:3}}>
          <button className="btn btn-alert" onClick={()=>dispatch({type:"THREAT"})}>⚡  THREAT ZONE</button>
          <button className="btn btn-alert" onClick={()=>dispatch({type:"GPS"})}>📡  GPS DEGRADE</button>
          <button className="btn btn-alert" onClick={()=>dispatch({type:"WEATHER"})}>🌪  BAD WEATHER</button>
          <button className="btn"           onClick={()=>dispatch({type:"URGENT"})}>🚨  URGENT MEDEVAC</button>
          <button className="btn" style={{marginTop:4,borderColor:"rgba(255,48,64,0.15)",color:"rgba(255,48,64,0.4)"}} onClick={()=>dispatch({type:"RESET"})}>⊗  RESET MISSION</button>
        </div>

        <div className="panel-header" style={{marginTop:4}}>FLEET STATUS</div>
        <div style={{flex:1,overflowY:"auto",padding:"8px"}}>
          {Object.values(world.assets).map(a=>{
            const color=ASSET_COLORS[a.id]??"#fff";
            const bc=a.battery>40?"#00ff88":a.battery>15?"#f0a500":"#ff3040";
            return (
              <div key={a.id} style={{marginBottom:10,paddingBottom:8,borderBottom:"1px solid rgba(0,200,255,0.07)"}}>
                <div style={{color,fontFamily:"'Share Tech Mono',monospace",fontSize:10,marginBottom:2,display:"flex",alignItems:"center",gap:6}}>
                  <span>{a.type==="drone"?"✦":"◈"}</span><span>{a.id}</span>
                  <span style={{color:"rgba(255,255,255,0.2)",fontSize:7}}>{a.type.toUpperCase()}</span>
                </div>
                <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"var(--text-dim)",lineHeight:1.8}}>
                  <div>({a.pos[0]},{a.pos[1]}) · <span style={{color: a.status==="idle"?"#00ff8888":a.status==="critical"?"#ff3040":"var(--text-dim)"}}>{a.status.toUpperCase()}</span></div>
                  <div>TASK: <span style={{color:a.currentTask?color:"rgba(255,255,255,0.15)"}}>{a.currentTask??"—"}</span></div>
                  {a.cargo.length>0&&<div style={{color:"rgba(255,255,255,0.3)"}}>{a.cargo.map(c=>`${c.quantity}×${c.type.substring(0,3).toUpperCase()}`).join(" ")}</div>}
                  <div>BATT <span style={{color:bc}}>{a.battery.toFixed(0)}%</span> · BASE {world.nodes[a.homeNodeId]?.name.split(" ")[1]??a.homeNodeId}</div>
                </div>
                <div style={{height:2,background:"rgba(255,255,255,0.05)",marginTop:3,borderRadius:1}}>
                  <div style={{height:"100%",width:`${a.battery}%`,background:bc,borderRadius:1,transition:"width 0.4s"}}/>
                </div>
              </div>
            );
          })}
        </div>

        <div className="panel-header">PLANNER WEIGHTS</div>
        <div style={{padding:"5px 8px 8px",fontFamily:"'Share Tech Mono',monospace",fontSize:8}}>
          {Object.entries(weights).map(([k,v])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"1.5px 0",color:"var(--text-dim)"}}>
              <span>{k.toUpperCase()}</span><span style={{color:"var(--amber)"}}>{(v as number).toFixed(1)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── RIGHT PANEL ─────────────────────────────────────────── */}
      <div className="panel" style={{position:"absolute",right:10,top:50,bottom:10,width:270,zIndex:100,display:"flex",flexDirection:"column",borderRadius:2,overflow:"hidden"}}>
        {/* Tabs */}
        <div style={{display:"flex",borderBottom:"1px solid rgba(0,200,255,0.12)"}}>
          {(["missions","supply","aip"] as RightTab[]).map(tab=>(
            <button key={tab} onClick={()=>setRightTab(tab)} style={{
              flex:1,padding:"7px 4px",fontFamily:"'Share Tech Mono',monospace",fontSize:9,
              letterSpacing:"0.12em",textTransform:"uppercase",cursor:"pointer",border:"none",
              borderBottom: tab===rightTab?"2px solid #00e5ff":"2px solid transparent",
              background:"transparent",
              color:tab===rightTab?"#00e5ff":"rgba(0,200,255,0.3)",
              transition:"all 0.15s",
            }}>{tab.toUpperCase()}</button>
          ))}
        </div>

        {/* MISSIONS tab */}
        {rightTab==="missions"&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div className="panel-header" style={{display:"flex",justifyContent:"space-between"}}>
              <span>MISSION QUEUE</span>
              <span style={{color:"rgba(0,200,255,0.3)",fontSize:8}}>{Object.values(world.tasks).filter(t=>!["complete","cancelled"].includes(t.status)).length} ACTIVE</span>
            </div>
            <div style={{flex:1,overflowY:"auto"}}>
              {Object.values(world.tasks).length===0&&(
                <div style={{padding:"12px",fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:"var(--text-dim)"}}>No missions yet. Run the simulation to auto-generate resupply tasks.</div>
              )}
              {Object.values(world.tasks).sort((a,b)=>b.priority-a.priority).map(task=>(
                <TaskCard key={task.id} task={task}
                  onApprove={task.status==="pending"?()=>dispatch({type:"APPROVE",taskId:task.id}):undefined}
                  onCancel={!["complete","cancelled","failed"].includes(task.status)?()=>dispatch({type:"CANCEL",taskId:task.id}):undefined}
                  srcName={world.nodes[task.sourceNodeId]?.name??task.sourceNodeId}
                  dstName={world.nodes[task.destNodeId]?.name??task.destNodeId}
                />
              ))}
            </div>
            <div className="panel-header">DECISION FEED</div>
            <div ref={logRef} style={{height:160,overflowY:"auto",padding:"5px 8px"}}>
              {world.log.length===0?(
                <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:"var(--text-dim)"}}>awaiting operations...</div>
              ):world.log.map((e,i)=>{
                const m=e.msg;
                const c=m.includes("⚠")||m.includes("🔋")?"rgba(240,165,0,0.75)":m.includes("✓")?"rgba(0,255,136,0.75)":m.includes("🚨")?"rgba(255,48,64,0.75)":m.includes("↺")||m.includes("📡")||m.includes("🎯")||m.includes("🌪")?"rgba(0,229,255,0.75)":"";
                return <div key={i} className="log-line" style={{color:c||undefined}}>
                  <span style={{color:"rgba(0,200,255,0.18)",marginRight:5}}>[{String(e.tick).padStart(3,"0")}]</span>{m}
                </div>;
              })}
            </div>
          </div>
        )}

        {/* SUPPLY tab */}
        {rightTab==="supply"&&(
          <div style={{flex:1,overflowY:"auto"}}>
            {Object.values(world.nodes).map(node=>{
              const NODE_COLORS: Record<string,string> = {fob:"#00e5ff",depot:"#f0a500",outpost:"#ff6644",lz:"#88ff44"};
              const color = NODE_COLORS[node.type]??"#fff";
              const cargoEntries = Object.entries(node.inventory) as [CargoType,number][];
              return (
                <div key={node.id} style={{padding:"10px 10px 8px",borderBottom:"1px solid rgba(0,200,255,0.07)"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:10,color,letterSpacing:"0.1em"}}>{node.name}</div>
                    <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(255,255,255,0.2)",textTransform:"uppercase"}}>{node.type}</div>
                  </div>
                  {cargoEntries.map(([cargo,inv])=>{
                    const pct = (inv/node.capacity[cargo])*100;
                    const bc = pct<30?"#ff3040":pct<60?"#f0a500":CARGO_COLOR[cargo];
                    const isCritical = pct < node.criticalThreshold*100;
                    return (
                      <div key={cargo} style={{marginBottom:4}}>
                        <div style={{display:"flex",justifyContent:"space-between",fontFamily:"'Share Tech Mono',monospace",fontSize:8,marginBottom:2}}>
                          <span style={{color:CARGO_COLOR[cargo],display:"flex",alignItems:"center",gap:4}}>
                            {isCritical&&<span style={{color:"#ff3040",fontSize:9}}>!</span>}
                            {cargo.toUpperCase()}
                          </span>
                          <span style={{color:bc}}>{Math.round(inv)}/{node.capacity[cargo]}</span>
                        </div>
                        <div style={{height:3,background:"rgba(255,255,255,0.05)",borderRadius:1}}>
                          <div style={{height:"100%",width:`${pct}%`,background:bc,borderRadius:1,transition:"width 0.5s",
                            boxShadow:isCritical?`0 0 4px ${bc}`:undefined}}/>
                        </div>
                      </div>
                    );
                  })}
                  {/* Demand indicators */}
                  <div style={{marginTop:4,fontFamily:"'Share Tech Mono',monospace",fontSize:7,color:"rgba(255,255,255,0.18)",display:"flex",flexWrap:"wrap",gap:"2px 8px"}}>
                    {Object.entries(node.demandPerTick).filter(([,v])=>(v as number)>0).map(([c,v])=>(
                      <span key={c}>⬇ {c.substring(0,3).toUpperCase()} {(v as number).toFixed(1)}/t</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* AIP tab */}
        {rightTab==="aip"&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div style={{padding:"8px",borderBottom:"1px solid rgba(0,200,255,0.08)"}}>
              <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"var(--text-dim)",marginBottom:6,lineHeight:1.6}}>
                OPERATOR INTENT → CONSTRAINTS → LIVE REPLANNING<br/>
                <span style={{color:"rgba(0,200,255,0.3)"}}>Try: "route all medevac by ground", "suggest ammo resupply to Delta", "explain current risk"</span>
              </div>
              <textarea className="aip-input" rows={3}
                placeholder={"e.g. avoid threat zones\nprioritize medevac missions\nsuggest resupply for Outpost Delta"}
                value={aipInput}
                onChange={e=>setAipInput(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendAIP();}}}
              />
              <button className="btn btn-primary" style={{marginTop:4}} onClick={sendAIP} disabled={aipLoading}>
                {aipLoading?"⟳  PROCESSING...":"▶  SEND TO AIP"}
              </button>
              {lastAIP&&(
                <div style={{marginTop:8,padding:8,background:"rgba(0,8,4,0.85)",border:"1px solid rgba(0,255,136,0.1)",fontFamily:"'Share Tech Mono',monospace"}}>
                  <div style={{color:"var(--amber)",fontSize:8,marginBottom:3,letterSpacing:"0.15em"}}>ACTION: {lastAIP.action.toUpperCase()}</div>
                  <div style={{color:"rgba(0,255,136,0.75)",fontSize:9,lineHeight:1.6}}>{lastAIP.explanation}</div>
                  {lastAIP.weights&&(
                    <div style={{marginTop:4,color:"rgba(0,200,100,0.45)",fontSize:8,display:"flex",flexWrap:"wrap",gap:"3px 8px"}}>
                      {Object.entries(lastAIP.weights).map(([k,v])=><span key={k}>{k}:{(v as number).toFixed(1)}</span>)}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="panel-header">DECISION FEED</div>
            <div ref={logRef} style={{flex:1,overflowY:"auto",padding:"5px 8px"}}>
              {world.log.map((e,i)=>{
                const m=e.msg;
                const c=m.includes("⚠")||m.includes("🔋")?"rgba(240,165,0,0.75)":m.includes("✓")?"rgba(0,255,136,0.75)":m.includes("🚨")?"rgba(255,48,64,0.75)":m.includes("↺")||m.includes("📡")||m.includes("🎯")?"rgba(0,229,255,0.75)":"";
                return <div key={i} className="log-line" style={{color:c||undefined}}>
                  <span style={{color:"rgba(0,200,255,0.18)",marginRight:5}}>[{String(e.tick).padStart(3,"0")}]</span>{m}
                </div>;
              })}
            </div>
          </div>
        )}

        {/* Bottom legend */}
        <div style={{padding:"5px 8px",borderTop:"1px solid rgba(0,200,255,0.08)",fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"var(--text-dim)"}}>
          <div style={{display:"flex",flexWrap:"wrap",gap:"3px 10px"}}>
            <span><span style={{color:"#ff3040"}}>■</span> NO-GO</span>
            <span><span style={{color:"#ff6600"}}>■</span> THREAT</span>
            <span><span style={{color:"#8844ff"}}>■</span> GPS-DENY</span>
            <span><span style={{color:"#f0a500"}}>●</span> PENDING</span>
            <span><span style={{color:"#00e5ff"}}>●</span> QUEUED/ACTIVE</span>
            <span><span style={{color:"#00ff88"}}>●</span> DONE</span>
          </div>
        </div>
      </div>

      {/* Bottom strip */}
      <div style={{position:"absolute",bottom:0,left:195,right:290,fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(0,200,255,0.2)",padding:"4px 12px",letterSpacing:"0.1em",zIndex:100,textAlign:"center",pointerEvents:"none"}}>
        WIND: {world.weather.windSpeed.toFixed(1)} kts · VIS: {(world.weather.visibility*100).toFixed(0)}% · UNCLASSIFIED // FOR DEMONSTRATION ONLY
      </div>
    </div>
  );
}

function HudStat({label,value,color}:{label:string;value:string;color:string}) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
      <span style={{fontSize:7,color:"rgba(0,200,255,0.3)",letterSpacing:"0.18em",fontFamily:"'Share Tech Mono',monospace"}}>{label}</span>
      <span style={{fontSize:13,color,fontFamily:"'Share Tech Mono',monospace"}}>{value}</span>
    </div>
  );
}

function ToggleBtn({active,onClick,label}:{active:boolean;onClick:()=>void;label:string}) {
  return (
    <button onClick={onClick} style={{
      fontFamily:"'Share Tech Mono',monospace",fontSize:8,letterSpacing:"0.12em",
      padding:"3px 8px",border:"1px solid",cursor:"pointer",background:"transparent",
      borderColor:active?"rgba(0,229,255,0.5)":"rgba(0,200,255,0.15)",
      color:active?"#00e5ff":"rgba(0,200,255,0.3)",transition:"all 0.12s",
    }}>{label}</button>
  );
}

function TaskCard({task,onApprove,onCancel,srcName,dstName}:{
  task:Task; onApprove?:()=>void; onCancel?:()=>void; srcName:string; dstName:string;
}) {
  const statusColor = TASK_STATUS_COLOR[task.status]??"#888";
  const mainCargo = task.cargo[0];
  return (
    <div style={{padding:"8px 10px",borderBottom:"1px solid rgba(0,200,255,0.07)",fontFamily:"'Share Tech Mono',monospace"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          {mainCargo&&<span style={{fontSize:9,color:CARGO_COLOR[mainCargo.type]??'#888'}}>
            {mainCargo.type==="medevac"?"🚑":mainCargo.type==="ammo"?"💥":mainCargo.type==="fuel"?"⛽":mainCargo.type==="food"?"🍱":"📦"}
          </span>}
          <span style={{fontSize:10,color:"var(--text-bright)"}}>{task.id}</span>
          <span style={{fontSize:8,color:"rgba(255,255,255,0.25)"}}>P{task.priority}</span>
        </div>
        <span style={{fontSize:8,color:statusColor}}>{task.status.toUpperCase()}</span>
      </div>
      <div style={{fontSize:8,color:"var(--text-dim)",lineHeight:1.7,marginBottom:4}}>
        <div>{srcName} → {dstName}</div>
        <div style={{display:"flex",gap:8}}>
          {task.cargo.map((c,i)=>(
            <span key={i} style={{color:CARGO_COLOR[c.type]??'#888'}}>{c.quantity}× {c.type}</span>
          ))}
          {task.riskScore>0&&<span style={{color:task.riskScore>0.5?"#ff6600":"rgba(255,255,255,0.2)"}}>RISK: {task.riskScore.toFixed(2)}</span>}
        </div>
        {task.assignedAsset&&<div style={{color:"rgba(0,229,255,0.5)"}}>ASSET: {task.assignedAsset}</div>}
      </div>
      {(onApprove||onCancel)&&(
        <div style={{display:"flex",gap:4}}>
          {onApprove&&<button className="btn btn-primary" style={{fontSize:8,padding:"3px 8px",flex:1}} onClick={onApprove}>✓ APPROVE</button>}
          {onCancel&&<button className="btn btn-alert" style={{fontSize:8,padding:"3px 8px",flex:1}} onClick={onCancel}>✗ CANCEL</button>}
        </div>
      )}
    </div>
  );
}
