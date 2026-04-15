"use client";
import { useReducer, useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type {
  SystemState, CountyData, ResponseTask, ResponseResource,
  NWSAlert, AIPResponse, ScoringWeights,
} from "@/lib/types";
import {
  ALERT_COLOR, TASK_COLOR, TASK_ICON, RESOURCE_COLOR, RESOURCE_ICON,
  DEFAULT_WEIGHTS,
} from "@/lib/types";
import {
  buildInitialState, ingestAlerts, ingestDeclarations, ingestCensus, ingestHospitals,
  recomputeAllRiskScores, autoGenerateTasks, runAssignmentCycle,
  applyWeightOverride, cancelTask, approveTask,
} from "@/lib/engine";
import { SIM_SCENARIOS, buildScenarioAlerts } from "@/lib/simulation";
import { generateIncidentReport } from "@/lib/report";

const MapView          = dynamic(() => import("@/components/MapView"),          { ssr: false });
const CountyDetailPanel = dynamic(() => import("@/components/CountyDetailPanel"), { ssr: false });

// ── Reducer ───────────────────────────────────────────────────────────────────
type Action =
  | { type:"SET_LOADING"; stage:string }
  | { type:"SET_COUNTIES_GEO"; geojson:any }
  | { type:"INGEST_ALERTS"; alerts:any[] }
  | { type:"INGEST_FEMA"; declarations:any[] }
  | { type:"INGEST_CENSUS"; counties:Record<string,any> }
  | { type:"INGEST_HOSPITALS"; hospitals:any[]; counties:Record<string,any> }
  | { type:"APPLY_WEIGHTS"; overrides:Partial<ScoringWeights> }
  | { type:"CANCEL_TASK"; taskId:string }
  | { type:"APPROVE_TASK"; taskId:string }
  | { type:"AIP"; payload:AIPResponse }
  
  | { type:"FOUNDRY_WRITEBACK"; taskId:string; success:boolean };

function reducer(s: SystemState, a: Action): SystemState {
  switch(a.type) {
    case"SET_LOADING": return{...s,isLoading:true,loadingStage:a.stage};
    case"SET_COUNTIES_GEO": return{...s,countyGeoJSON:a.geojson};
    case"INGEST_ALERTS":{
      let ns=ingestAlerts(s,a.alerts);
      return{...ns,isLoading:false,freshness:{...ns.freshness,nws:new Date().toISOString()}};
    }
    case"INGEST_FEMA":    return ingestDeclarations(s,a.declarations);
    case"INGEST_CENSUS":  return ingestCensus(s,a.counties);
    case"INGEST_HOSPITALS":{
      const hosps=a.hospitals.map((h:any)=>{
        const m=Object.values(a.counties).find((c:any)=>c.name?.toUpperCase()===h.countyName?.replace(" COUNTY","").toUpperCase());
        return{...h,countyFips:(m as any)?.fips??""};
      }).filter((h:any)=>h.countyFips);
      return ingestHospitals(s,hosps);
    }
    case"APPLY_WEIGHTS": return applyWeightOverride(s,a.overrides);
    case"CANCEL_TASK":   return cancelTask(s,a.taskId);
    case"APPROVE_TASK":  return approveTask(s,a.taskId);
    case"AIP":{
      const r=a.payload;
      let ns={...s,
        log:[...s.log.slice(-199),{id:`L${s.logCounter+1}`,timestamp:new Date().toISOString(),level:"aip" as const,message:`💬 AIP: ${r.message}`}],
        logCounter:s.logCounter+1,
      };
      if(r.weightOverrides) ns=applyWeightOverride(ns,r.weightOverrides);
      return ns;
    }
    
    case"FOUNDRY_WRITEBACK":{
      const msg=a.success
        ?`✓ Foundry writeback: task ${a.taskId} committed to Ontology`
        :`⚠ Foundry writeback failed for ${a.taskId} — state held locally`;
      return{...s,log:[...s.log.slice(-199),{id:`L${s.logCounter+1}`,timestamp:new Date().toISOString(),level:a.success?"action":"warning",message:msg}],logCounter:s.logCounter+1};
    }
    default: return s;
  }
}

type RTab="tasks"|"resources"|"aip"|"ontology";

export default function Home(){
  const[state,dispatch]=useReducer(reducer,buildInitialState());
  const[tab,setTab]=useState<RTab>("tasks");
  const[selectedFips,setSelectedFips]=useState<string|null>(null);
  const[showDetail,setShowDetail]=useState(false);
  const[aipInput,setAipInput]=useState("");
  const[aipLoading,setAipLoading]=useState(false);
  const[lastAIP,setLastAIP]=useState<AIPResponse|null>(null);
  const[weightEdit,setWeightEdit]=useState(false);
  const[weights,setWeights]=useState<ScoringWeights>({...DEFAULT_WEIGHTS});
  const[simRunning,setSimRunning]=useState(false);
  const prevStateRef=useRef<SystemState|null>(null);
  const[prevState,setPrevState]=useState<SystemState|null>(null);
  const logRef=useRef<HTMLDivElement>(null);

  // ── Initial data load ─────────────────────────────────────────────────────
  useEffect(()=>{
    async function loadAll(){
      dispatch({type:"SET_LOADING",stage:"Loading county boundaries..."});
      try{ const geo=await fetch("/api/counties").then(r=>r.json()); dispatch({type:"SET_COUNTIES_GEO",geojson:geo}); }catch{}

      dispatch({type:"SET_LOADING",stage:"Loading Census ACS demographics..."});
      try{ const c=await fetch("/api/census").then(r=>r.json()); if(c.counties)dispatch({type:"INGEST_CENSUS",counties:c.counties}); }catch{}

      dispatch({type:"SET_LOADING",stage:"Loading FEMA disaster declarations..."});
      try{ const f=await fetch("/api/fema").then(r=>r.json()); if(f.declarations)dispatch({type:"INGEST_FEMA",declarations:f.declarations}); }catch{}

      dispatch({type:"SET_LOADING",stage:"Loading HIFLD hospital data..."});
      try{
        const[hosp,census2]=await Promise.all([fetch("/api/hospitals").then(r=>r.json()),fetch("/api/census").then(r=>r.json())]);
        if(hosp.hospitals)dispatch({type:"INGEST_HOSPITALS",hospitals:hosp.hospitals,counties:census2.counties??{}});
      }catch{}

      dispatch({type:"SET_LOADING",stage:"Fetching live NWS alerts..."});
      try{ const nws=await fetch("/api/nws").then(r=>r.json()); dispatch({type:"INGEST_ALERTS",alerts:nws.alerts??[]}); }
      catch{ dispatch({type:"INGEST_ALERTS",alerts:[]}); }
    }
    loadAll();
  },[]);

  // NWS refresh every 2 min
  useEffect(()=>{
    const iv=setInterval(async()=>{
      try{ const nws=await fetch("/api/nws").then(r=>r.json()); dispatch({type:"INGEST_ALERTS",alerts:nws.alerts??[]}); }catch{}
    },120000);
    return()=>clearInterval(iv);
  },[]);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[state.log]);

  // Track previous state for change detection
  useEffect(()=>{
    setPrevState(prevStateRef.current);
    prevStateRef.current=state;
  },[state]);

  // ── Foundry writeback ─────────────────────────────────────────────────────
  const writeToFoundry=useCallback(async(actionType:string,parameters:Record<string,unknown>,taskId:string)=>{
    try{
      const res=await fetch("/api/foundry/actions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actionType,parameters})});
      const data=await res.json();
      dispatch({type:"FOUNDRY_WRITEBACK",taskId,success:data.configured&&data.success});
    }catch{
      dispatch({type:"FOUNDRY_WRITEBACK",taskId,success:false});
    }
  },[]);

  const handleApproveTask=useCallback((taskId:string)=>{
    dispatch({type:"APPROVE_TASK",taskId});
    writeToFoundry("approve-response-task",{taskId},taskId);
  },[writeToFoundry]);

  const handleCancelTask=useCallback((taskId:string)=>{
    dispatch({type:"CANCEL_TASK",taskId});
    writeToFoundry("cancel-response-task",{taskId},taskId);
  },[writeToFoundry]);

  // ── AIP ───────────────────────────────────────────────────────────────────
  const sendAIP=useCallback(async()=>{
    if(!aipInput.trim()||aipLoading) return;
    setAipLoading(true);
    const ctx={
      topCountiesByRisk:Object.values(state.counties).sort((a,b)=>b.riskScore-a.riskScore).slice(0,15).map(c=>({
        fips:c.fips,name:c.name,riskScore:+(c.riskScore*100).toFixed(1),
        alertLevel:c.alertLevel,alerts:c.alerts.map(a=>a.event).slice(0,2),
        hasDeclaration:c.hasDeclaration,hospitals:c.hospitals.length,
        vulnerability:+(c.vulnerabilityScore*100).toFixed(1),population:c.population,
      })),
      totalAlerts:state.alerts.length,
      pendingTasks:Object.values(state.tasks).filter(t=>t.status==="pending").length,
      assignedTasks:Object.values(state.tasks).filter(t=>t.status==="assigned").length,
      availableResources:Object.values(state.resources).filter(r=>r.status==="available").length,
      shortfall:state.shortfallAnalysis?.summary,
      currentWeights:state.weights,
    };
    try{
      const res=await fetch("/api/aip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:aipInput,context:ctx})});
      const r:AIPResponse=await res.json();
      setLastAIP(r);
      dispatch({type:"AIP",payload:r});
      setAipInput("");
    }finally{setAipLoading(false);}
  },[aipInput,aipLoading,state]);

  // ── Report export ─────────────────────────────────────────────────────────
  const exportReport=useCallback(()=>{
    const html=generateIncidentReport(state);
    const blob=new Blob([html],{type:"text/html"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`aegis-incident-report-${new Date().toISOString().slice(0,10)}.html`;
    a.click(); URL.revokeObjectURL(url);
  },[state]);

  // ── Simulation ────────────────────────────────────────────────────────────
  const runScenario=useCallback(async(scenarioId:string)=>{
    const scenario=SIM_SCENARIOS.find(s=>s.id===scenarioId);
    if(!scenario||simRunning) return;
    setSimRunning(true);
    const alerts=buildScenarioAlerts(scenario);
    dispatch({type:"INGEST_ALERTS",alerts:[...state.alerts,...alerts]});
    await new Promise(r=>setTimeout(r,2000));
    setSimRunning(false);
  },[state.alerts,simRunning]);

  const clearSimulation=useCallback(()=>{
    dispatch({type:"INGEST_ALERTS",alerts:[]});
  },[]);

  const{counties,tasks,resources,alerts,shortfallAnalysis,log,freshness}=state;
  const sortedCounties=Object.values(counties).sort((a,b)=>b.riskScore-a.riskScore).filter(c=>c.population>0);
  const taskList=Object.values(tasks).sort((a,b)=>b.priorityScore-a.priorityScore);
  const pendingTasks=taskList.filter(t=>t.status==="pending");
  const activeTasks=taskList.filter(t=>["assigned","in_progress"].includes(t.status));
  const selectedCounty=selectedFips?counties[selectedFips]:null;

  const handleCountyClick=useCallback((fips:string)=>{
    setSelectedFips(fips);
    setShowDetail(true);
  },[]);

  return(
    <div style={{position:"fixed",inset:0,overflow:"hidden",background:"var(--bg)"}}>
      <div style={{position:"absolute",inset:0}}>
        <MapView state={state} prevState={prevState} onCountyClick={handleCountyClick} selectedFips={selectedFips}/>
      </div>

      {/* County detail overlay */}
      {showDetail&&selectedCounty&&(
        <CountyDetailPanel county={selectedCounty} onClose={()=>setShowDetail(false)}/>
      )}

      {/* ── TOP HUD ── */}
      <div style={{position:"absolute",top:0,left:0,right:0,zIndex:100,background:"linear-gradient(180deg,rgba(4,6,10,0.97) 0%,rgba(4,6,10,0.55) 100%)",borderBottom:"1px solid rgba(255,120,0,0.15)",padding:"7px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",backdropFilter:"blur(8px)"}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:15,fontWeight:700,color:"var(--orange)",letterSpacing:"0.3em"}}>AEGIS</span>
          <span style={{width:1,height:18,background:"rgba(255,120,0,0.2)",display:"block"}}/>
          <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(255,120,0,0.5)",letterSpacing:"0.2em"}}>CRITICAL INFRASTRUCTURE RESPONSE COORDINATOR</span>
          <span style={{width:1,height:18,background:"rgba(255,120,0,0.2)",display:"block"}}/>
          <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(255,120,0,0.3)"}}>GEORGIA STATE EMERGENCY OPERATIONS</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:14,fontFamily:"'Share Tech Mono',monospace"}}>
          <DataPill label="NWS" ts={freshness.nws} warn={!freshness.nws}/>
          <DataPill label="FEMA" ts={freshness.fema} warn={!freshness.fema}/>
          <DataPill label="CENSUS" ts={freshness.census} warn={!freshness.census}/>
          <DataPill label="HIFLD" ts={freshness.hospitals} warn={!freshness.hospitals}/>
          <div style={{width:1,height:14,background:"rgba(255,120,0,0.15)"}}/>
          <HudStat label="ALERTS"   value={String(alerts.length)}   color={alerts.length>0?"#ff6600":"#444"}/>
          <HudStat label="AT-RISK"  value={String(sortedCounties.filter(c=>c.riskScore>0.35).length)} color="#f0a500"/>
          <HudStat label="TASKS"    value={String(taskList.length)}  color="#ffcc00"/>
          <HudStat label="GAP"      value={String(shortfallAnalysis?.uncoveredTasks??0)} color={shortfallAnalysis?.uncoveredTasks?"#ff2020":"#444"}/>
          <div style={{width:1,height:14,background:"rgba(255,120,0,0.15)"}}/>
          <button onClick={exportReport} style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,padding:"3px 8px",border:"1px solid rgba(255,120,0,0.3)",background:"transparent",color:"rgba(255,120,0,0.6)",cursor:"pointer",letterSpacing:"0.1em"}} title="Export incident report as HTML">⬇ REPORT</button>
          {state.isLoading&&<span style={{fontSize:8,color:"rgba(255,120,0,0.5)",letterSpacing:"0.1em"}} className="pulse-warn">{state.loadingStage}</span>}
        </div>
      </div>

      {/* ── LEFT: County rankings ── */}
      <div className="panel" style={{position:"absolute",left:10,top:50,bottom:10,width:215,zIndex:100,display:"flex",flexDirection:"column",borderRadius:2,overflow:"hidden"}}>
        <div className="panel-header" style={{display:"flex",justifyContent:"space-between"}}>
          <span>COUNTY RISK RANKING</span>
          <span style={{color:"rgba(255,120,0,0.4)",fontSize:8}}>{sortedCounties.length}</span>
        </div>
        <div style={{flex:1,overflowY:"auto"}}>
          {sortedCounties.slice(0,60).map((county,i)=>(
            <CountyRow key={county.fips} county={county} rank={i+1}
              isSelected={selectedFips===county.fips}
              onClick={()=>handleCountyClick(county.fips)}/>
          ))}
        </div>

        {/* Scoring weights */}
        <div style={{borderTop:"1px solid rgba(255,120,0,0.12)"}}>
          <div className="panel-header" style={{cursor:"pointer",display:"flex",justifyContent:"space-between"}} onClick={()=>setWeightEdit(!weightEdit)}>
            <span>SCORING WEIGHTS</span>
            <span style={{color:"rgba(255,120,0,0.4)",fontSize:8}}>{weightEdit?"▲ CLOSE":"▼ EDIT"}</span>
          </div>
          {weightEdit?(
            <div style={{padding:"8px"}}>
              {(Object.keys(weights) as (keyof ScoringWeights)[]).map(k=>(
                <div key={k} style={{display:"flex",alignItems:"center",gap:5,marginBottom:5}}>
                  <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:7,color:"rgba(255,120,0,0.55)",width:85,flexShrink:0}}>{k.replace(/([A-Z])/g," $1").toUpperCase()}</span>
                  <input type="range" min="0" max="1" step="0.05" value={weights[k]} onChange={e=>setWeights(w=>({...w,[k]:+e.target.value}))} style={{flex:1,accentColor:"var(--orange)"}}/>
                  <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"var(--orange)",width:28,textAlign:"right"}}>{weights[k].toFixed(2)}</span>
                </div>
              ))}
              <button className="btn btn-primary" style={{marginTop:4,fontSize:8,padding:"4px"}} onClick={()=>{dispatch({type:"APPLY_WEIGHTS",overrides:weights});setWeightEdit(false);}}>APPLY & RECOMPUTE</button>
            </div>
          ):(
            <div style={{padding:"4px 8px",display:"flex",flexWrap:"wrap",gap:"3px 8px",fontFamily:"'Share Tech Mono',monospace",fontSize:7,color:"rgba(255,120,0,0.3)"}}>
              {Object.entries(state.weights).map(([k,v])=><span key={k}>{k.replace(/([A-Z])/g," $1").toLowerCase().split(" ")[0]}:{v.toFixed(2)}</span>)}
            </div>
          )}
        </div>

        {/* Simulation panel */}
        <div style={{borderTop:"1px solid rgba(255,120,0,0.12)"}}>
          <div className="panel-header">DEMO SCENARIOS</div>
          <div style={{padding:"6px 8px",display:"flex",flexDirection:"column",gap:3}}>
            {SIM_SCENARIOS.map(s=>(
              <button key={s.id} className="btn" style={{fontSize:8,textAlign:"left"}} disabled={simRunning}
                onClick={()=>runScenario(s.id)} title={s.description}>
                {simRunning?"⟳ ":""}{s.name.split("—")[0].trim()}
              </button>
            ))}
            <button className="btn btn-danger" style={{fontSize:8,marginTop:3}} onClick={clearSimulation}>✕ CLEAR SIM ALERTS</button>
          </div>
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="panel" style={{position:"absolute",right:10,top:50,bottom:10,width:295,zIndex:100,display:"flex",flexDirection:"column",borderRadius:2,overflow:"hidden"}}>
        <div style={{display:"flex",borderBottom:"1px solid rgba(255,120,0,0.12)"}}>
          {(["tasks","resources","aip","ontology"] as RTab[]).map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:"7px 2px",fontFamily:"'Share Tech Mono',monospace",fontSize:8,letterSpacing:"0.1em",textTransform:"uppercase",cursor:"pointer",border:"none",background:"transparent",borderBottom:`2px solid ${t===tab?"var(--orange)":"transparent"}`,color:t===tab?"var(--orange)":"rgba(255,120,0,0.28)",transition:"all 0.12s"}}>
              {t==="tasks"?`TASKS${taskList.length>0?` (${taskList.length})`:""}`:t.toUpperCase()}
            </button>
          ))}
        </div>

        {/* TASKS tab */}
        {tab==="tasks"&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            {shortfallAnalysis&&shortfallAnalysis.uncoveredTasks>0&&(
              <div style={{padding:"7px 10px",background:"rgba(255,32,32,0.07)",borderBottom:"1px solid rgba(255,32,32,0.18)",fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"#ff6060",lineHeight:1.6}}>
                ⚠ SHORTFALL: {shortfallAnalysis.summary}
              </div>
            )}
            {shortfallAnalysis&&shortfallAnalysis.uncoveredTasks===0&&taskList.length>0&&(
              <div style={{padding:"5px 10px",background:"rgba(0,180,60,0.05)",borderBottom:"1px solid rgba(0,180,60,0.12)",fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(0,200,80,0.65)"}}>
                ✓ All {shortfallAnalysis.highPriorityTasks} high-priority tasks covered
              </div>
            )}
            <div className="panel-header" style={{display:"flex",justifyContent:"space-between"}}>
              <span>RESPONSE TASKS</span>
              <span style={{color:"rgba(255,120,0,0.4)",fontSize:8}}>{pendingTasks.length} PENDING</span>
            </div>
            <div style={{flex:1,overflowY:"auto"}}>
              {taskList.length===0&&(
                <div style={{padding:"14px 12px",fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:"rgba(255,255,255,0.2)",lineHeight:1.8}}>
                  Loading data...<br/>Tasks auto-generate as county risk scores are computed.
                </div>
              )}
              {taskList.map(task=>(
                <TaskCard key={task.id} task={task}
                  resource={task.assignedResourceId?resources[task.assignedResourceId]:null}
                  countyName={counties[task.targetFips]?.name}
                  onApprove={()=>handleApproveTask(task.id)}
                  onCancel={()=>handleCancelTask(task.id)}
                />
              ))}
            </div>
            <div className="panel-header">ACTIVITY FEED</div>
            <div ref={logRef} style={{height:145,overflowY:"auto",padding:"4px 8px"}}>
              {[...log].reverse().map(e=>{
                const c=e.level==="critical"?"rgba(255,32,32,0.8)":e.level==="warning"?"rgba(255,120,0,0.75)":e.level==="action"?"rgba(0,200,80,0.75)":e.level==="aip"?"rgba(0,229,255,0.7)":"rgba(255,255,255,0.2)";
                return<div key={e.id} className="log-line" style={{color:c||undefined}}>
                  <span style={{color:"rgba(255,120,0,0.2)",marginRight:4}}>{new Date(e.timestamp).toLocaleTimeString("en",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>{e.message}
                </div>;
              })}
            </div>
          </div>
        )}

        {/* RESOURCES tab */}
        {tab==="resources"&&(
          <div style={{flex:1,overflowY:"auto"}}>
            <div style={{padding:"6px 10px 4px",fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:"rgba(255,120,0,0.5)",borderBottom:"1px solid rgba(255,120,0,0.08)"}}>
              {Object.values(resources).filter(r=>r.status==="available").length} AVAILABLE · {Object.values(resources).filter(r=>r.status==="deployed").length} DEPLOYED
            </div>
            {Object.values(resources).map(r=>{
              const task=r.assignedTaskId?tasks[r.assignedTaskId]:null;
              const rc=RESOURCE_COLOR[r.type]??"#fff";
              return(
                <div key={r.id} style={{padding:"8px 10px",borderBottom:"1px solid rgba(255,120,0,0.06)"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                    <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:10,color:rc,display:"flex",alignItems:"center",gap:5}}>
                      <span>{RESOURCE_ICON[r.type]}</span><span>{r.label}</span>
                    </div>
                    <span style={{fontSize:8,color:r.status==="available"?"rgba(0,200,80,0.7)":r.status==="deployed"?"rgba(255,120,0,0.7)":"rgba(255,255,255,0.2)",fontFamily:"'Share Tech Mono',monospace"}}>{r.status.toUpperCase()}</span>
                  </div>
                  <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(255,255,255,0.3)",lineHeight:1.8}}>
                    <div>BASE: {r.baseName}</div>
                    {task&&<div style={{color:rc}}>→ {task.id}: {task.targetName} Co.</div>}
                    {r.notes&&<div style={{color:"rgba(255,255,255,0.2)"}}>{r.notes}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* AIP tab */}
        {tab==="aip"&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div style={{padding:"8px 10px",borderBottom:"1px solid rgba(255,120,0,0.08)"}}>
              <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(255,120,0,0.4)",marginBottom:5,lineHeight:1.7}}>
                AIP OPERATIONS COPILOT<br/>
                <span style={{color:"rgba(255,120,0,0.22)"}}>synthesize situation · recommend actions · explain rankings · apply operator overrides</span>
              </div>
              <textarea className="aip-input" rows={3} value={aipInput}
                placeholder={"synthesize the current situation\nrecommend immediate actions\nprioritize hospital-serving counties\nwhat counties need shelter support?"}
                onChange={e=>setAipInput(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendAIP();}}}
              />
              <button className="btn btn-primary" style={{marginTop:4}} onClick={sendAIP} disabled={aipLoading}>
                {aipLoading?"⟳ PROCESSING...":"▶ SEND TO AIP"}
              </button>
              {lastAIP&&(
                <div style={{marginTop:8,padding:"8px 10px",background:"rgba(0,6,3,0.85)",border:"1px solid rgba(0,200,80,0.12)",fontFamily:"'Share Tech Mono',monospace"}}>
                  <div style={{fontSize:8,color:"var(--orange)",marginBottom:3,letterSpacing:"0.15em"}}>{lastAIP.action.replace(/_/g," ").toUpperCase()}</div>
                  <div style={{fontSize:9,color:"rgba(200,240,220,0.85)",lineHeight:1.7}}>{lastAIP.message}</div>
                  {lastAIP.weightOverrides&&(
                    <div style={{marginTop:5,fontSize:8,color:"rgba(255,120,0,0.5)"}}>
                      ↻ Weights updated: {Object.entries(lastAIP.weightOverrides).map(([k,v])=>`${k}=${(v as number).toFixed(2)}`).join(", ")}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="panel-header">ACTIVITY FEED</div>
            <div ref={logRef} style={{flex:1,overflowY:"auto",padding:"4px 8px"}}>
              {[...log].reverse().map(e=>{
                const c=e.level==="critical"?"rgba(255,32,32,0.8)":e.level==="warning"?"rgba(255,120,0,0.75)":e.level==="action"?"rgba(0,200,80,0.75)":e.level==="aip"?"rgba(0,229,255,0.7)":"rgba(255,255,255,0.2)";
                return<div key={e.id} className="log-line" style={{color:c||undefined}}>
                  <span style={{color:"rgba(255,120,0,0.2)",marginRight:4}}>{new Date(e.timestamp).toLocaleTimeString("en",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>{e.message}
                </div>;
              })}
            </div>
          </div>
        )}

        {/* ONTOLOGY tab */}
        {tab==="ontology"&&(
          <OntologyPanel
            counties={counties} alerts={state.alerts} declarations={state.declarations}
            hospitals={state.hospitals} resources={resources} tasks={tasks}
          />
        )}

        <div style={{padding:"5px 8px",borderTop:"1px solid rgba(255,120,0,0.08)",fontFamily:"'Share Tech Mono',monospace",fontSize:7.5,color:"var(--text-dim)"}}>
          <div style={{display:"flex",flexWrap:"wrap",gap:"3px 10px"}}>
            <span><span style={{color:"#ff2020"}}>■</span> CRITICAL &gt;75%</span>
            <span><span style={{color:"#ff6600"}}>■</span> HIGH 55–75%</span>
            <span><span style={{color:"#f0a500"}}>■</span> ELEVATED</span>
            <span><span style={{color:"#ffcc00"}}>■</span> MOD</span>
            <span><span style={{color:"rgba(0,150,200,0.5)"}}>■</span> LOW</span>
          </div>
        </div>
      </div>

      <div style={{position:"absolute",bottom:0,left:235,right:310,fontFamily:"'Share Tech Mono',monospace",fontSize:7.5,color:"rgba(255,120,0,0.18)",padding:"3px 12px",zIndex:100,textAlign:"center",pointerEvents:"none",letterSpacing:"0.1em"}}>
        GEORGIA EMERGENCY OPERATIONS · {sortedCounties.filter(c=>c.alertLevel!=="none").length} COUNTIES UNDER ALERT · NWS · OPENFEMA · CENSUS ACS 2022 · HIFLD
      </div>
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────────
function CountyRow({county,rank,isSelected,onClick}:{county:CountyData;rank:number;isSelected:boolean;onClick:()=>void}){
  const rc=county.riskScore>0.65?"#ff2020":county.riskScore>0.45?"#ff6600":county.riskScore>0.25?"#f0a500":county.riskScore>0.1?"#ffcc00":"#2a3040";
  return(
    <div onClick={onClick} style={{padding:"5px 8px",borderBottom:"1px solid rgba(255,120,0,0.06)",cursor:"pointer",background:isSelected?"rgba(255,120,0,0.08)":"transparent",display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(255,120,0,0.22)",width:18,textAlign:"right"}}>{rank}</span>
      <div style={{flex:1}}>
        <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:isSelected?"var(--orange)":"rgba(255,255,255,0.7)"}}>
          {county.name}
          {county.hospitals.length>0&&<span style={{color:"rgba(255,60,60,0.55)",marginLeft:4,fontSize:8}}>🏥{county.hospitals.length}</span>}
          {county.hasDeclaration&&<span style={{color:"rgba(255,200,0,0.45)",marginLeft:3,fontSize:7}}>⚡</span>}
        </div>
        <div style={{height:2.5,background:"rgba(255,255,255,0.05)",borderRadius:1,marginTop:2}}>
          <div style={{height:"100%",width:`${county.riskScore*100}%`,background:rc,borderRadius:1,transition:"width 0.5s"}}/>
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:1}}>
        <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:rc}}>{(county.riskScore*100).toFixed(0)}</span>
        {county.alertLevel!=="none"&&<span style={{fontSize:7,color:ALERT_COLOR[county.alertLevel]}}>{county.alertLevel.toUpperCase().slice(0,4)}</span>}
      </div>
    </div>
  );
}

function TaskCard({task,resource,countyName,onApprove,onCancel}:{task:ResponseTask;resource:ResponseResource|null;countyName:string|undefined;onApprove:()=>void;onCancel:()=>void}){
  const tc=TASK_COLOR[task.type]??"#888";
  const sc=task.priorityScore>=80?"#ff2020":task.priorityScore>=60?"#ff6600":task.priorityScore>=40?"#f0a500":"#444";
  const isDone=["complete","cancelled","rejected"].includes(task.status);
  const canAct=!isDone&&task.status!=="in_progress";
  return(
    <div style={{padding:"7px 10px",borderBottom:"1px solid rgba(255,120,0,0.06)",opacity:isDone?0.45:1}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:3}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <span style={{fontSize:12}}>{TASK_ICON[task.type]}</span>
          <div>
            <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:tc}}>{task.type.replace(/_/g," ").toUpperCase()}</div>
            <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(255,255,255,0.45)"}}>{countyName??task.targetName} Co. · {task.id}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:5,alignItems:"center",flexShrink:0}}>
          <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:9,color:sc,fontWeight:700}}>P{task.priorityScore}</span>
          <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:task.status==="assigned"||task.status==="in_progress"?"rgba(0,200,80,0.7)":task.status==="pending"?"rgba(255,120,0,0.7)":"rgba(255,255,255,0.2)"}}>{task.status.toUpperCase()}</span>
        </div>
      </div>
      <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(255,255,255,0.25)",lineHeight:1.6,marginBottom:resource||canAct?4:0}}>
        {task.triggerReason}
        {resource&&<div style={{color:RESOURCE_COLOR[resource.type],marginTop:1}}>→ {resource.label} ({resource.type.replace(/_/g," ")})</div>}
      </div>
      {canAct&&(
        <div style={{display:"flex",gap:4}}>
          {task.status==="pending"&&<button onClick={onApprove} style={{flex:1,padding:"3px",background:"rgba(0,180,60,0.08)",border:"1px solid rgba(0,180,60,0.3)",color:"rgba(0,200,80,0.85)",fontFamily:"'Share Tech Mono',monospace",fontSize:8,cursor:"pointer",letterSpacing:"0.08em"}}>▶ ACTIVATE</button>}
          <button onClick={onCancel} style={{flex:1,padding:"3px",background:"transparent",border:"1px solid rgba(255,50,50,0.18)",color:"rgba(255,50,50,0.45)",fontFamily:"'Share Tech Mono',monospace",fontSize:8,cursor:"pointer"}}>✗ CANCEL</button>
        </div>
      )}
    </div>
  );
}

function HudStat({label,value,color}:{label:string;value:string;color:string}){
  return<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
    <span style={{fontSize:7,color:"rgba(255,120,0,0.3)",letterSpacing:"0.18em",fontFamily:"'Share Tech Mono',monospace"}}>{label}</span>
    <span style={{fontSize:12,color,fontFamily:"'Share Tech Mono',monospace"}}>{value}</span>
  </div>;
}

function DataPill({label,ts,warn}:{label:string;ts:string|null;warn?:boolean}){
  const age=ts?Math.round((Date.now()-new Date(ts).getTime())/60000):null;
  return<div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:8,display:"flex",alignItems:"center",gap:3}}>
    <span style={{color:warn?"rgba(255,50,50,0.5)":age&&age<5?"rgba(0,200,80,0.6)":"rgba(255,120,0,0.4)"}}>●</span>
    <span style={{color:"rgba(255,255,255,0.25)"}}>{label}</span>
    {age!==null&&<span style={{color:"rgba(255,120,0,0.25)"}}>{age}m</span>}
  </div>;
}

function OntologyPanel({counties,alerts,declarations,hospitals,resources,tasks}:{
  counties:Record<string,CountyData>;alerts:NWSAlert[];declarations:any[];
  hospitals:any[];resources:Record<string,ResponseResource>;tasks:Record<string,ResponseTask>;
}){
  const[foundryStatus,setFoundryStatus]=useState<any>(null);
  const[loadingObjects,setLoadingObjects]=useState(false);
  const[liveObjects,setLiveObjects]=useState<any[]>([]);
  const[selectedObjType,setSelectedObjType]=useState("");

  useEffect(()=>{ fetch("/api/foundry/status").then(r=>r.json()).then(setFoundryStatus).catch(()=>{}); },[]);

  const queryObjects=async(type:string)=>{
    setLoadingObjects(true); setSelectedObjType(type); setLiveObjects([]);
    try{
      const res=await fetch(`/api/foundry/objects?type=${type}&pageSize=15`);
      const data=await res.json();
      setLiveObjects(data.objects??[]);
    }finally{setLoadingObjects(false);}
  };

  const isFoundry=foundryStatus?.configured&&foundryStatus?.connected;
  const statusColor=!foundryStatus?"#555":isFoundry?"#00ff88":foundryStatus?.configured?"#ff6600":"#f0a500";

  return(
    <div style={{flex:1,overflowY:"auto",fontFamily:"'Share Tech Mono',monospace"}}>
      {/* Connection status */}
      <div style={{padding:"10px",borderBottom:"1px solid rgba(255,120,0,0.1)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
          <span style={{fontSize:9,color:"rgba(255,120,0,0.6)",letterSpacing:"0.2em"}}>FOUNDRY PLATFORM SDK</span>
          <span style={{fontSize:8,color:statusColor,letterSpacing:"0.1em"}}>● {!foundryStatus?"CHECKING...":isFoundry?"CONNECTED":foundryStatus?.configured?"AUTH ERROR":"STANDALONE"}</span>
        </div>
        {foundryStatus&&(
          <div style={{fontSize:8,color:"rgba(255,255,255,0.3)",lineHeight:1.8}}>
            {isFoundry?(
              <>
                <div style={{color:"rgba(0,200,255,0.6)",marginBottom:3}}>{foundryStatus.stack}</div>
                <div>@osdk/foundry v{foundryStatus.sdkVersion} · {foundryStatus.ontologyRid?.slice(0,35)}...</div>
                <div style={{display:"flex",gap:10,marginTop:4,flexWrap:"wrap"}}>
                  {[["OBJECTS",foundryStatus.capabilities?.ontologyRead],["ACTIONS",foundryStatus.capabilities?.ontologyWrite],["DATASETS",foundryStatus.capabilities?.datasets],["AIP AGENT",foundryStatus.capabilities?.aipAgent]].map(([l,ok])=>(
                    <span key={l as string} style={{color:ok?"rgba(0,200,80,0.7)":"rgba(255,255,255,0.15)"}}>{ok?"✓":"○"} {l}</span>
                  ))}
                </div>
              </>
            ):(
              <div>
                <div style={{color:"rgba(255,165,0,0.6)",marginBottom:3}}>Standalone mode — @osdk/foundry v{foundryStatus.sdkVersion}</div>
                <div style={{color:"rgba(255,255,255,0.2)",lineHeight:1.9}}>
                  Add to .env.local to connect:<br/>
                  {["FOUNDRY_STACK","FOUNDRY_CLIENT_ID","FOUNDRY_CLIENT_SECRET","FOUNDRY_ONTOLOGY_RID","FOUNDRY_AIP_AGENT_RID (opt)"].map(k=>(
                    <div key={k} style={{color:"rgba(0,200,255,0.4)"}}>{k}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Ontology objects */}
      <div style={{padding:"8px 10px",borderBottom:"1px solid rgba(255,120,0,0.1)"}}>
        <div style={{fontSize:8,color:"rgba(255,120,0,0.4)",letterSpacing:"0.18em",marginBottom:8}}>ONTOLOGY OBJECTS</div>
        {[
          {obj:"CountyRegion",count:Object.keys(counties).length,color:"#f0a500",desc:"ACS demographics · risk scores · alert levels",api:"county-region"},
          {obj:"HazardEvent",count:alerts.length,color:"#ff6600",desc:"Active NWS alerts · zone geometries",api:"hazard-event"},
          {obj:"FEMADeclaration",count:declarations.length,color:"#ff2020",desc:"Disaster declarations · 5yr window",api:null},
          {obj:"CriticalFacility",count:hospitals.length,color:"#ff3040",desc:"HIFLD hospitals · beds · coordinates",api:"critical-facility"},
          {obj:"ResponseResource",count:Object.keys(resources).length,color:"#00e5ff",desc:"Crews · generators · shelter teams",api:"response-resource"},
          {obj:"ResponseTask",count:Object.keys(tasks).length,color:"#ffcc00",desc:"Auto-generated · priority scored",api:"response-task"},
        ].map(row=>(
          <div key={row.obj} style={{marginBottom:6,padding:"6px 8px",background:"rgba(0,0,0,0.25)",border:`1px solid ${row.color}15`,cursor:row.api&&isFoundry?"pointer":"default"}}
            onClick={()=>row.api&&isFoundry&&queryObjects(row.api)}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
              <span style={{color:row.color,fontSize:9}}>{row.obj}</span>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                {row.api&&isFoundry&&<span style={{fontSize:7,color:"rgba(0,200,255,0.45)"}}>QUERY ▶</span>}
                <span style={{color:row.color,fontSize:11,fontWeight:700}}>{row.count}</span>
              </div>
            </div>
            <div style={{fontSize:7,color:"rgba(255,255,255,0.2)"}}>{row.desc}</div>
          </div>
        ))}
      </div>

      {/* Live query results */}
      {(loadingObjects||liveObjects.length>0)&&(
        <div style={{padding:"8px 10px",borderBottom:"1px solid rgba(255,120,0,0.1)"}}>
          <div style={{fontSize:8,color:"rgba(0,200,255,0.5)",letterSpacing:"0.15em",marginBottom:5}}>LIVE: {selectedObjType.toUpperCase()}</div>
          {loadingObjects?<div style={{fontSize:8,color:"rgba(0,200,255,0.4)"}}>Querying Ontology...</div>:
          liveObjects.map((obj,i)=>(
            <div key={i} style={{padding:"4px 6px",marginBottom:3,background:"rgba(0,0,0,0.3)",border:"1px solid rgba(0,200,255,0.07)",fontSize:8,color:"rgba(255,255,255,0.4)"}}>
              {Object.entries(obj).filter(([k])=>k!=="__rid"&&k!=="$rid").slice(0,4).map(([k,v])=>(
                <span key={k} style={{marginRight:10}}><span style={{color:"rgba(0,200,255,0.4)"}}>{k}:</span> {String(v).slice(0,18)}</span>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Relationships */}
      <div style={{padding:"8px 10px",borderBottom:"1px solid rgba(255,120,0,0.1)"}}>
        <div style={{fontSize:8,color:"rgba(255,120,0,0.4)",letterSpacing:"0.18em",marginBottom:8}}>LINK TYPES</div>
        {[["HazardEvent","impacts","CountyRegion"],["CountyRegion","contains","CriticalFacility"],["CountyRegion","requires","ResponseTask"],["ResponseTask","assigned_to","ResponseResource"],["ResponseResource","deployed_to","CountyRegion"]].map(([f,r,t])=>(
          <div key={r+t} style={{display:"flex",alignItems:"center",gap:5,marginBottom:4,fontSize:8}}>
            <span style={{color:"#f0a500"}}>{f}</span>
            <span style={{color:"rgba(255,255,255,0.18)"}}>→{r}→</span>
            <span style={{color:"#f0a500"}}>{t}</span>
          </div>
        ))}
      </div>

      {/* SDK snippet */}
      <div style={{padding:"8px 10px"}}>
        <div style={{fontSize:8,color:"rgba(255,120,0,0.4)",letterSpacing:"0.18em",marginBottom:6}}>SDK (@osdk/foundry)</div>
        <pre style={{fontSize:7,color:"rgba(0,200,255,0.4)",lineHeight:1.7,whiteSpace:"pre-wrap",background:"rgba(0,0,0,0.4)",padding:8,border:"1px solid rgba(0,200,255,0.07)"}}>
{`// Query CountyRegion objects
OntologyObjectsV2.list(client,
  ontologyRid, "county-region",
  { select: ["countyFips",
    "riskScore","alertLevel"],
    orderBy: { fields: [{
      field: "riskScore",
      direction: "DESC" }] }
  }
);

// Apply ResponseTask action
Actions.apply(client, ontologyRid,
  "assign-resource-to-task",
  { parameters: { taskId, resourceId }}
);

// AIP Agent session
const s = await Sessions.create(
  client, agentRid, {});
await Sessions.blockingContinue(
  client, agentRid, s.rid,
  { userInput: { text: msg },
    parameterInputs: {} });`}
        </pre>
      </div>
    </div>
  );
}
