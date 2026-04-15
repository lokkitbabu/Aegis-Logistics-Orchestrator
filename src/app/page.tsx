"use client";
import { useReducer, useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type {
  SystemState, CountyData, ResponseTask, ResponseResource,
  NWSAlert, AIPResponse, ScoringWeights, TaskStatus,
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

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

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
  | { type:"REFRESH_NWS" }
  | { type:"AIP_RESPONSE"; response:AIPResponse }
  | { type:"SET_FRESHNESS"; key:string; value:string };

function reducer(state: SystemState, action: Action): SystemState {
  switch (action.type) {
    case "SET_LOADING": return { ...state, isLoading:true, loadingStage:action.stage };
    case "SET_COUNTIES_GEO": return { ...state, countyGeoJSON:action.geojson };
    case "INGEST_ALERTS": {
      let s = ingestAlerts(state, action.alerts);
      return { ...s, isLoading:false, freshness:{...s.freshness, nws:new Date().toISOString()} };
    }
    case "INGEST_FEMA": return ingestDeclarations(state, action.declarations);
    case "INGEST_CENSUS": return ingestCensus(state, action.counties);
    case "INGEST_HOSPITALS": {
      // Join hospitals to counties by county name
      const hosps = action.hospitals.map((h:any) => {
        const match = Object.values(action.counties).find((c:any) => c.name?.toUpperCase()===h.countyName?.replace(" COUNTY","").toUpperCase());
        return {...h, countyFips:(match as any)?.fips??""};
      }).filter((h:any)=>h.countyFips);
      return ingestHospitals(state, hosps);
    }
    case "APPLY_WEIGHTS": return applyWeightOverride(state, action.overrides);
    case "CANCEL_TASK": return cancelTask(state, action.taskId);
    case "APPROVE_TASK": return approveTask(state, action.taskId);
    case "AIP_RESPONSE": {
      const r = action.response;
      let s = { ...state,
        log:[...state.log.slice(-199),{id:`L${state.logCounter+1}`,timestamp:new Date().toISOString(),level:"aip" as const,message:`💬 AIP: ${r.message}`}],
        logCounter:state.logCounter+1,
      };
      if (r.weightOverrides) s = applyWeightOverride(s, r.weightOverrides);
      return s;
    }
    default: return state;
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
type RTab = "tasks"|"resources"|"aip"|"ontology";

export default function Home() {
  const [state, dispatch] = useReducer(reducer, buildInitialState());
  const [tab, setTab] = useState<RTab>("tasks");
  const [selectedFips, setSelectedFips] = useState<string | null>(null);
  const [aipInput, setAipInput] = useState("");
  const [aipLoading, setAipLoading] = useState(false);
  const [lastAIP, setLastAIP] = useState<AIPResponse | null>(null);
  const [weightEdit, setWeightEdit] = useState(false);
  const [weights, setWeights] = useState<ScoringWeights>({ ...DEFAULT_WEIGHTS });
  const logRef = useRef<HTMLDivElement>(null);

  // ── Data loading ──────────────────────────────────────────────────────────
  useEffect(() => {
    async function loadAll() {
      // 1. County GeoJSON
      dispatch({ type:"SET_LOADING", stage:"Loading Georgia county boundaries..." });
      try {
        const geo = await fetch("/api/counties").then(r=>r.json());
        dispatch({ type:"SET_COUNTIES_GEO", geojson:geo });
      } catch {}

      // 2. Census (baseline data, no external API limits)
      dispatch({ type:"SET_LOADING", stage:"Loading Census vulnerability data..." });
      try {
        const census = await fetch("/api/census").then(r=>r.json());
        if (census.counties) dispatch({ type:"INGEST_CENSUS", counties:census.counties });
      } catch {}

      // 3. FEMA declarations
      dispatch({ type:"SET_LOADING", stage:"Loading FEMA disaster declarations..." });
      try {
        const fema = await fetch("/api/fema").then(r=>r.json());
        if (fema.declarations) dispatch({ type:"INGEST_FEMA", declarations:fema.declarations });
      } catch {}

      // 4. Hospitals
      dispatch({ type:"SET_LOADING", stage:"Loading HIFLD hospital data..." });
      try {
        const [hosp, census2] = await Promise.all([
          fetch("/api/hospitals").then(r=>r.json()),
          fetch("/api/census").then(r=>r.json()),
        ]);
        if (hosp.hospitals) dispatch({ type:"INGEST_HOSPITALS", hospitals:hosp.hospitals, counties:census2.counties??{} });
      } catch {}

      // 5. NWS alerts (live)
      dispatch({ type:"SET_LOADING", stage:"Fetching live NWS alerts..." });
      try {
        const nws = await fetch("/api/nws").then(r=>r.json());
        dispatch({ type:"INGEST_ALERTS", alerts:nws.alerts??[] });
      } catch {
        dispatch({ type:"INGEST_ALERTS", alerts:[] });
      }
    }
    loadAll();
  }, []);

  // Refresh NWS every 2 minutes
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const nws = await fetch("/api/nws").then(r=>r.json());
        dispatch({ type:"INGEST_ALERTS", alerts:nws.alerts??[] });
      } catch {}
    }, 120000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state.log]);

  const sendAIP = useCallback(async () => {
    if (!aipInput.trim() || aipLoading) return;
    setAipLoading(true);
    const topCounties = Object.values(state.counties).sort((a,b)=>b.riskScore-a.riskScore).slice(0,15).map(c=>({
      fips:c.fips, name:c.name, riskScore:+(c.riskScore*100).toFixed(1),
      alertLevel:c.alertLevel, alerts:c.alerts.map(a=>a.event).slice(0,2),
      hasDeclaration:c.hasDeclaration, hospitals:c.hospitals.length,
      vulnerability:+(c.vulnerabilityScore*100).toFixed(1), population:c.population,
    }));
    const ctx = {
      topCountiesByRisk:topCounties,
      totalAlerts:state.alerts.length, totalTasks:Object.keys(state.tasks).length,
      pendingTasks:Object.values(state.tasks).filter(t=>t.status==="pending").length,
      assignedTasks:Object.values(state.tasks).filter(t=>t.status==="assigned").length,
      availableResources:Object.values(state.resources).filter(r=>r.status==="available").length,
      shortfall:state.shortfallAnalysis?.summary,
      currentWeights:state.weights,
    };
    try {
      const res = await fetch("/api/aip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:aipInput,context:ctx})});
      const r: AIPResponse = await res.json();
      setLastAIP(r);
      dispatch({ type:"AIP_RESPONSE", response:r });
      setAipInput("");
    } finally { setAipLoading(false); }
  }, [aipInput, aipLoading, state]);

  const applyWeights = () => {
    dispatch({ type:"APPLY_WEIGHTS", overrides:weights });
    setWeightEdit(false);
  };

  const { counties, tasks, resources, alerts, shortfallAnalysis, log, freshness } = state;
  const sortedCounties = Object.values(counties).sort((a,b)=>b.riskScore-a.riskScore).filter(c=>c.population>0);
  const taskList = Object.values(tasks).sort((a,b)=>b.priorityScore-a.priorityScore);
  const pendingTasks = taskList.filter(t=>t.status==="pending");
  const activeTasks  = taskList.filter(t=>["assigned","in_progress"].includes(t.status));
  const selectedCounty = selectedFips ? counties[selectedFips] : null;

  return (
    <div style={{ position:"fixed", inset:0, overflow:"hidden", background:"var(--bg)" }}>
      {/* Map */}
      <div style={{ position:"absolute", inset:0 }}>
        <MapView state={state} onCountyClick={setSelectedFips} selectedFips={selectedFips} />
      </div>

      {/* ── TOP HUD ─────────────────────────────────────────────── */}
      <div style={{ position:"absolute", top:0, left:0, right:0, zIndex:100, background:"linear-gradient(180deg,rgba(4,6,10,0.97) 0%,rgba(4,6,10,0.6) 100%)", borderBottom:"1px solid rgba(255,120,0,0.15)", padding:"7px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", backdropFilter:"blur(8px)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ fontFamily:"'Rajdhani',sans-serif", fontSize:15, fontWeight:700, color:"var(--orange)", letterSpacing:"0.3em" }}>AEGIS</div>
          <div style={{ width:1, height:18, background:"rgba(255,120,0,0.2)" }}/>
          <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(255,120,0,0.5)", letterSpacing:"0.2em" }}>CRITICAL INFRASTRUCTURE RESPONSE COORDINATOR</div>
          <div style={{ width:1, height:18, background:"rgba(255,120,0,0.2)" }}/>
          <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(255,120,0,0.35)" }}>GEORGIA STATE EMERGENCY OPERATIONS</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:16, fontFamily:"'Share Tech Mono',monospace" }}>
          {/* Data freshness */}
          <DataPill label="NWS" ts={freshness.nws} warn={!freshness.nws} />
          <DataPill label="FEMA" ts={freshness.fema} warn={!freshness.fema} />
          <DataPill label="CENSUS" ts={freshness.census} warn={!freshness.census} />
          <DataPill label="HIFLD" ts={freshness.hospitals} warn={!freshness.hospitals} />
          <div style={{ width:1, height:14, background:"rgba(255,120,0,0.15)" }}/>
          <HudStat label="ALERTS"   value={String(alerts.length)}              color={alerts.length>0?"#ff6600":"#555"} />
          <HudStat label="COUNTIES" value={String(sortedCounties.filter(c=>c.riskScore>0.35).length)} color="#f0a500" />
          <HudStat label="TASKS"    value={String(taskList.length)}            color="#ffcc00" />
          <HudStat label="UNCOVER"  value={String(shortfallAnalysis?.uncoveredTasks??0)} color={shortfallAnalysis?.uncoveredTasks?"#ff2020":"#555"} />
          {state.isLoading && <div style={{ fontSize:8, color:"rgba(255,120,0,0.6)", letterSpacing:"0.1em" }} className="pulse-warn">{state.loadingStage}</div>}
        </div>
      </div>

      {/* ── LEFT: County Rankings ─────────────────────────────── */}
      <div className="panel" style={{ position:"absolute", left:10, top:50, bottom:10, width:215, zIndex:100, display:"flex", flexDirection:"column", borderRadius:2, overflow:"hidden" }}>
        <div className="panel-header" style={{ display:"flex", justifyContent:"space-between" }}>
          <span>COUNTY RISK RANKING</span>
          <span style={{ color:"rgba(255,120,0,0.4)", fontSize:8 }}>{sortedCounties.length} COUNTIES</span>
        </div>
        <div style={{ flex:1, overflowY:"auto" }}>
          {sortedCounties.slice(0,50).map((county, i) => (
            <CountyRow key={county.fips} county={county} rank={i+1} isSelected={selectedFips===county.fips} onClick={()=>setSelectedFips(county.fips)} />
          ))}
        </div>

        {/* Selected county detail */}
        {selectedCounty && (
          <div style={{ borderTop:"1px solid rgba(255,120,0,0.15)", padding:"8px 10px", background:"rgba(0,0,0,0.4)" }}>
            <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:9, color:"var(--orange)", marginBottom:5, letterSpacing:"0.1em" }}>{selectedCounty.name.toUpperCase()} CO. DETAIL</div>
            <DataRow label="POPULATION"  value={selectedCounty.population.toLocaleString()} />
            <DataRow label="ELDERLY"     value={`${selectedCounty.elderlyPct?.toFixed(1)??0}%`} warn={selectedCounty.elderlyPct>18}/>
            <DataRow label="NO VEHICLE"  value={`${selectedCounty.noVehiclePct?.toFixed(1)??0}%`} warn={selectedCounty.noVehiclePct>12}/>
            <DataRow label="POVERTY"     value={`${selectedCounty.povertyPct?.toFixed(1)??0}%`} warn={selectedCounty.povertyPct>20}/>
            <DataRow label="HOSPITALS"   value={String(selectedCounty.hospitals.length)} warn={selectedCounty.hospitals.length===0}/>
            <DataRow label="RISK SCORE"  value={`${(selectedCounty.riskScore*100).toFixed(0)}%`} color={selectedCounty.riskScore>0.6?"#ff3020":selectedCounty.riskScore>0.35?"#f0a500":"#00cc44"}/>
            <DataRow label="ALERT"       value={selectedCounty.alertLevel.toUpperCase()} color={ALERT_COLOR[selectedCounty.alertLevel]}/>
            {selectedCounty.alerts.slice(0,2).map((a,i)=>(<div key={i} style={{fontSize:8,color:"rgba(255,120,0,0.5)",fontFamily:"'Share Tech Mono',monospace",marginTop:2,paddingLeft:4,borderLeft:`2px solid ${ALERT_COLOR[a.level]}`}}>{a.event}</div>))}
            {selectedCounty.hasDeclaration && <div style={{ marginTop:3, fontSize:8, color:"#ffcc00", fontFamily:"'Share Tech Mono',monospace" }}>⚡ FEMA DECLARED</div>}
          </div>
        )}

        {/* Weights panel */}
        <div style={{ borderTop:"1px solid rgba(255,120,0,0.12)" }}>
          <div className="panel-header" style={{ cursor:"pointer", display:"flex", justifyContent:"space-between" }} onClick={()=>setWeightEdit(!weightEdit)}>
            <span>SCORING WEIGHTS</span>
            <span style={{ color:"rgba(255,120,0,0.4)", fontSize:8 }}>{weightEdit?"▲":"▼"}</span>
          </div>
          {weightEdit ? (
            <div style={{ padding:"6px 8px" }}>
              {(Object.keys(weights) as (keyof ScoringWeights)[]).map(k => (
                <div key={k} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                  <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:7, color:"rgba(255,120,0,0.6)", width:100 }}>{k.replace(/([A-Z])/g," $1").toUpperCase()}</span>
                  <input type="range" min="0" max="1" step="0.05" value={weights[k]} onChange={e=>setWeights(w=>({...w,[k]:+e.target.value}))} style={{ flex:1, accentColor:"var(--orange)" }}/>
                  <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"var(--orange)", width:28, textAlign:"right" }}>{weights[k].toFixed(2)}</span>
                </div>
              ))}
              <button className="btn btn-primary" style={{ marginTop:4, fontSize:8, padding:"4px" }} onClick={applyWeights}>APPLY & RECOMPUTE</button>
            </div>
          ) : (
            <div style={{ padding:"4px 8px", display:"flex", flexWrap:"wrap", gap:"3px 8px", fontFamily:"'Share Tech Mono',monospace", fontSize:7, color:"rgba(255,120,0,0.35)" }}>
              {Object.entries(state.weights).map(([k,v])=><span key={k}>{k.replace(/([A-Z])/g," $1").toLowerCase().split(" ")[0]}:{v.toFixed(2)}</span>)}
            </div>
          )}
        </div>
      </div>

      {/* ── RIGHT PANEL ──────────────────────────────────────── */}
      <div className="panel" style={{ position:"absolute", right:10, top:50, bottom:10, width:295, zIndex:100, display:"flex", flexDirection:"column", borderRadius:2, overflow:"hidden" }}>
        {/* Tabs */}
        <div style={{ display:"flex", borderBottom:"1px solid rgba(255,120,0,0.12)" }}>
          {(["tasks","resources","aip","ontology"] as RTab[]).map(t => (
            <button key={t} onClick={()=>setTab(t)} style={{ flex:1, padding:"7px 2px", fontFamily:"'Share Tech Mono',monospace", fontSize:8, letterSpacing:"0.1em", textTransform:"uppercase", cursor:"pointer", border:"none", background:"transparent", borderBottom:`2px solid ${t===tab?"var(--orange)":"transparent"}`, color:t===tab?"var(--orange)":"rgba(255,120,0,0.3)", transition:"all 0.12s" }}>
              {t==="tasks"?`TASKS (${taskList.length})`:t.toUpperCase()}
            </button>
          ))}
        </div>

        {/* TASKS tab */}
        {tab==="tasks" && (
          <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
            {/* Shortfall banner */}
            {shortfallAnalysis && shortfallAnalysis.uncoveredTasks > 0 && (
              <div style={{ padding:"8px 10px", background:"rgba(255,32,32,0.08)", borderBottom:"1px solid rgba(255,32,32,0.2)", fontFamily:"'Share Tech Mono',monospace", fontSize:9, color:"#ff6060", lineHeight:1.5 }}>
                ⚠ RESOURCE SHORTFALL: {shortfallAnalysis.summary}
              </div>
            )}
            {shortfallAnalysis && shortfallAnalysis.uncoveredTasks===0 && taskList.length>0 && (
              <div style={{ padding:"6px 10px", background:"rgba(0,180,60,0.06)", borderBottom:"1px solid rgba(0,180,60,0.15)", fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(0,200,80,0.7)" }}>
                ✓ All {shortfallAnalysis.highPriorityTasks} high-priority tasks covered
              </div>
            )}
            <div className="panel-header" style={{ display:"flex", justifyContent:"space-between" }}>
              <span>RESPONSE TASKS</span>
              <span style={{ color:"rgba(255,120,0,0.4)", fontSize:8 }}>{pendingTasks.length} PENDING</span>
            </div>
            <div style={{ flex:1, overflowY:"auto" }}>
              {taskList.length===0 && (
                <div style={{ padding:"16px 12px", fontFamily:"'Share Tech Mono',monospace", fontSize:9, color:"rgba(255,255,255,0.2)", lineHeight:1.7 }}>
                  Loading data...<br/>Tasks will auto-generate as counties are assessed.
                </div>
              )}
              {taskList.map(task => (
                <TaskCard key={task.id} task={task} county={counties[task.targetFips]}
                  resource={task.assignedResourceId ? resources[task.assignedResourceId] : null}
                  onApprove={()=>dispatch({type:"APPROVE_TASK",taskId:task.id})}
                  onCancel={()=>dispatch({type:"CANCEL_TASK",taskId:task.id})}
                />
              ))}
            </div>

            {/* Activity feed */}
            <div className="panel-header">ACTIVITY FEED</div>
            <div ref={logRef} style={{ height:150, overflowY:"auto", padding:"4px 8px" }}>
              {[...log].reverse().map(e => {
                const c = e.level==="critical"?"rgba(255,32,32,0.8)":e.level==="warning"?"rgba(255,120,0,0.75)":e.level==="action"?"rgba(0,200,80,0.75)":e.level==="aip"?"rgba(0,229,255,0.7)":"rgba(255,255,255,0.2)";
                return <div key={e.id} className="log-line" style={{ color:c }}>
                  <span style={{ color:"rgba(255,120,0,0.2)", marginRight:4 }}>{new Date(e.timestamp).toLocaleTimeString("en",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>{e.message}
                </div>;
              })}
            </div>
          </div>
        )}

        {/* RESOURCES tab */}
        {tab==="resources" && (
          <div style={{ flex:1, overflowY:"auto" }}>
            <div style={{ padding:"6px 10px 4px", fontFamily:"'Share Tech Mono',monospace", fontSize:9, color:"rgba(255,120,0,0.5)", borderBottom:"1px solid rgba(255,120,0,0.08)" }}>
              {Object.values(resources).filter(r=>r.status==="available").length} AVAILABLE · {Object.values(resources).filter(r=>r.status==="deployed").length} DEPLOYED
            </div>
            {Object.values(resources).map(r => (
              <div key={r.id} style={{ padding:"8px 10px", borderBottom:"1px solid rgba(255,120,0,0.06)" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                  <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, color:RESOURCE_COLOR[r.type], display:"flex", alignItems:"center", gap:5 }}>
                    <span>{RESOURCE_ICON[r.type]}</span><span>{r.label}</span>
                  </div>
                  <span style={{ fontSize:8, color:r.status==="available"?"rgba(0,200,80,0.7)":r.status==="deployed"?"rgba(255,120,0,0.7)":"rgba(255,255,255,0.2)", fontFamily:"'Share Tech Mono',monospace" }}>{r.status.toUpperCase()}</span>
                </div>
                <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(255,255,255,0.3)", lineHeight:1.7 }}>
                  <div>BASE: {r.baseName}</div>
                  {r.assignedTaskId && <div style={{ color:RESOURCE_COLOR[r.type] }}>TASK: {r.assignedTaskId} → {r.assignedFips ? (counties[r.assignedFips]?.name ?? r.assignedFips) : ""}</div>}
                  {r.notes && <div style={{ color:"rgba(255,255,255,0.2)" }}>{r.notes}</div>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* AIP tab */}
        {tab==="aip" && (
          <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
            <div style={{ padding:"8px 10px", borderBottom:"1px solid rgba(255,120,0,0.08)" }}>
              <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(255,120,0,0.4)", marginBottom:5, lineHeight:1.7 }}>
                AIP OPERATIONS COPILOT<br/>
                <span style={{ color:"rgba(255,120,0,0.25)" }}>e.g. "synthesize current situation", "recommend actions for top counties", "prioritize hospital-serving counties", "explain why Fulton ranks first"</span>
              </div>
              <textarea className="aip-input" rows={3} value={aipInput}
                placeholder={"synthesize the current situation\nrecommend immediate actions\nprioritize coastal counties\nexplain top county ranking"}
                onChange={e=>setAipInput(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendAIP();}}}
              />
              <button className="btn btn-primary" style={{ marginTop:4 }} onClick={sendAIP} disabled={aipLoading}>
                {aipLoading?"⟳ PROCESSING...":"▶ SEND TO AIP"}
              </button>
              {lastAIP && (
                <div style={{ marginTop:8, padding:"8px 10px", background:"rgba(0,8,4,0.8)", border:"1px solid rgba(0,229,255,0.12)", fontFamily:"'Share Tech Mono',monospace" }}>
                  <div style={{ fontSize:8, color:"var(--orange)", marginBottom:3, letterSpacing:"0.15em" }}>{lastAIP.action.replace(/_/g," ").toUpperCase()}</div>
                  <div style={{ fontSize:9, color:"rgba(200,240,220,0.8)", lineHeight:1.7 }}>{lastAIP.message}</div>
                  {lastAIP.weightOverrides && (
                    <div style={{ marginTop:4, fontSize:8, color:"rgba(255,120,0,0.5)" }}>
                      ↻ Weights updated: {Object.entries(lastAIP.weightOverrides).map(([k,v])=>`${k}=${v?.toFixed(2)}`).join(", ")}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="panel-header">ACTIVITY FEED</div>
            <div ref={logRef} style={{ flex:1, overflowY:"auto", padding:"4px 8px" }}>
              {[...log].reverse().map(e=>{
                const c=e.level==="critical"?"rgba(255,32,32,0.8)":e.level==="warning"?"rgba(255,120,0,0.75)":e.level==="action"?"rgba(0,200,80,0.75)":e.level==="aip"?"rgba(0,229,255,0.7)":"rgba(255,255,255,0.2)";
                return<div key={e.id} className="log-line" style={{color:c}}><span style={{color:"rgba(255,120,0,0.2)",marginRight:4}}>{new Date(e.timestamp).toLocaleTimeString("en",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>{e.message}</div>;
              })}
            </div>
          </div>
        )}

        {/* ONTOLOGY tab */}
        {tab==="ontology" && (
          <div style={{ flex:1, overflowY:"auto", padding:"8px 10px", fontFamily:"'Share Tech Mono',monospace" }}>
            <div style={{ fontSize:8, color:"rgba(255,120,0,0.5)", letterSpacing:"0.2em", marginBottom:10 }}>FOUNDRY ONTOLOGY — LIVE OBJECT COUNTS</div>
            {[
              { obj:"CountyRegion", count:Object.keys(counties).length, color:"#f0a500", desc:"ACS demographics + risk scores" },
              { obj:"HazardEvent", count:alerts.length, color:"#ff6600", desc:"Active NWS alerts" },
              { obj:"FEMADeclaration", count:state.declarations.length, color:"#ff2020", desc:"Disaster declarations (5yr)" },
              { obj:"CriticalFacility", count:state.hospitals.length, color:"#ff3040", desc:"HIFLD hospital locations" },
              { obj:"ResponseResource", count:Object.keys(resources).length, color:"#00e5ff", desc:"Crews, generators, teams" },
              { obj:"ResponseTask", count:Object.keys(tasks).length, color:"#ffcc00", desc:"Auto-generated from rules" },
            ].map(row => (
              <div key={row.obj} style={{ marginBottom:10, padding:"8px", background:"rgba(0,0,0,0.3)", border:`1px solid ${row.color}22` }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                  <span style={{ color:row.color, fontSize:10 }}>{row.obj}</span>
                  <span style={{ color:row.color, fontSize:12, fontWeight:700 }}>{row.count}</span>
                </div>
                <div style={{ fontSize:8, color:"rgba(255,255,255,0.25)" }}>{row.desc}</div>
              </div>
            ))}
            <div style={{ marginTop:8, fontSize:8, color:"rgba(255,120,0,0.3)", lineHeight:1.8 }}>
              RELATIONSHIPS:<br/>
              HazardEvent →impacts→ CountyRegion<br/>
              CountyRegion →contains→ CriticalFacility<br/>
              CountyRegion →requires→ ResponseTask<br/>
              ResponseTask →assigned_to→ ResponseResource
            </div>
            <div style={{ marginTop:10, fontSize:8, color:"rgba(255,120,0,0.2)" }}>
              DATA SOURCES:<br/>
              NWS api.weather.gov/alerts<br/>
              OpenFEMA fema.gov/api/open<br/>
              Census api.census.gov/data/acs5<br/>
              HIFLD services1.arcgis.com/Hp6G80
            </div>
          </div>
        )}
      </div>

      {/* Bottom strip */}
      <div style={{ position:"absolute", bottom:0, left:235, right:310, fontFamily:"'Share Tech Mono',monospace", fontSize:7.5, color:"rgba(255,120,0,0.2)", padding:"3px 12px", zIndex:100, textAlign:"center", pointerEvents:"none", letterSpacing:"0.1em" }}>
        GEORGIA EMERGENCY OPERATIONS · {sortedCounties.filter(c=>c.alertLevel!=="none").length} COUNTIES UNDER ALERT · DATA: NWS · OPENFEMA · CENSUS ACS · HIFLD
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function CountyRow({ county, rank, isSelected, onClick }: { county:CountyData; rank:number; isSelected:boolean; onClick:()=>void }) {
  const rc = county.riskScore>0.65?"#ff2020":county.riskScore>0.45?"#ff6600":county.riskScore>0.25?"#f0a500":county.riskScore>0.1?"#ffcc00":"#445";
  return (
    <div onClick={onClick} style={{ padding:"5px 8px", borderBottom:"1px solid rgba(255,120,0,0.06)", cursor:"pointer", background:isSelected?"rgba(255,120,0,0.08)":"transparent", display:"flex", alignItems:"center", gap:8 }}>
      <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(255,120,0,0.25)", width:18, textAlign:"right" }}>{rank}</span>
      <div style={{ flex:1 }}>
        <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:9, color:isSelected?"var(--orange)":"rgba(255,255,255,0.7)" }}>
          {county.name}
          {county.hospitals.length>0 && <span style={{ color:"rgba(255,48,48,0.6)", marginLeft:4, fontSize:8 }}>🏥{county.hospitals.length}</span>}
          {county.hasDeclaration && <span style={{ color:"rgba(255,200,0,0.5)", marginLeft:3, fontSize:7 }}>⚡</span>}
        </div>
        <div style={{ height:2.5, background:"rgba(255,255,255,0.05)", borderRadius:1, marginTop:2 }}>
          <div style={{ height:"100%", width:`${county.riskScore*100}%`, background:rc, borderRadius:1, transition:"width 0.5s" }}/>
        </div>
      </div>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:1 }}>
        <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:9, color:rc }}>{(county.riskScore*100).toFixed(0)}</span>
        {county.alertLevel!=="none"&&<span style={{ fontSize:7, color:ALERT_COLOR[county.alertLevel] }}>{county.alertLevel.toUpperCase()}</span>}
      </div>
    </div>
  );
}

function TaskCard({ task, county, resource, onApprove, onCancel }: { task:ResponseTask; county?:CountyData; resource:ResponseResource|null; onApprove:()=>void; onCancel:()=>void }) {
  const tc = TASK_COLOR[task.type]??"#888";
  const sc = task.priorityScore>=80?"#ff2020":task.priorityScore>=60?"#ff6600":task.priorityScore>=40?"#f0a500":"#555";
  const isPending = task.status==="pending";
  const isDone = ["complete","cancelled"].includes(task.status);
  return (
    <div style={{ padding:"7px 10px", borderBottom:"1px solid rgba(255,120,0,0.06)", opacity:isDone?0.5:1 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:3 }}>
        <div style={{ display:"flex", alignItems:"center", gap:5 }}>
          <span style={{ fontSize:12 }}>{TASK_ICON[task.type]}</span>
          <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:9, color:tc }}>{task.type.replace(/_/g," ").toUpperCase()}</span>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:9, color:sc, fontWeight:700 }}>P{task.priorityScore}</span>
          <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:task.status==="assigned"?"rgba(0,200,80,0.7)":task.status==="pending"?"rgba(255,120,0,0.7)":"rgba(255,255,255,0.25)" }}>{task.status.toUpperCase()}</span>
        </div>
      </div>
      <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(255,255,255,0.55)", marginBottom:2 }}>{task.targetName} County</div>
      <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(255,255,255,0.25)", lineHeight:1.6 }}>
        {task.triggerReason}
        {resource && <div style={{ color:RESOURCE_COLOR[resource.type] }}>→ {resource.label}</div>}
      </div>
      {!isDone && (
        <div style={{ display:"flex", gap:4, marginTop:5 }}>
          {isPending && <button onClick={onApprove} style={{ flex:1, padding:"3px", background:"rgba(0,180,60,0.08)", border:"1px solid rgba(0,180,60,0.3)", color:"rgba(0,200,80,0.8)", fontFamily:"'Share Tech Mono',monospace", fontSize:8, cursor:"pointer" }}>▶ ACTIVATE</button>}
          <button onClick={onCancel} style={{ flex:1, padding:"3px", background:"transparent", border:"1px solid rgba(255,50,50,0.2)", color:"rgba(255,50,50,0.4)", fontFamily:"'Share Tech Mono',monospace", fontSize:8, cursor:"pointer" }}>✗ CANCEL</button>
        </div>
      )}
    </div>
  );
}

function HudStat({ label, value, color }: { label:string; value:string; color:string }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1 }}>
      <span style={{ fontSize:7, color:"rgba(255,120,0,0.3)", letterSpacing:"0.18em", fontFamily:"'Share Tech Mono',monospace" }}>{label}</span>
      <span style={{ fontSize:12, color, fontFamily:"'Share Tech Mono',monospace" }}>{value}</span>
    </div>
  );
}

function DataPill({ label, ts, warn }: { label:string; ts:string|null; warn?:boolean }) {
  const age = ts ? Math.round((Date.now()-new Date(ts).getTime())/60000) : null;
  return (
    <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, display:"flex", alignItems:"center", gap:3 }}>
      <span style={{ color: warn?"rgba(255,50,50,0.5)":age&&age<5?"rgba(0,200,80,0.6)":"rgba(255,120,0,0.4)" }}>●</span>
      <span style={{ color:"rgba(255,255,255,0.25)" }}>{label}</span>
      {age!==null && <span style={{ color:"rgba(255,120,0,0.25)" }}>{age}m</span>}
    </div>
  );
}

function DataRow({ label, value, warn, color }: { label:string; value:string; warn?:boolean; color?:string }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"2px 0", borderBottom:"1px solid rgba(255,120,0,0.04)" }}>
      <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(255,255,255,0.25)" }}>{label}</span>
      <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:color||(warn?"#ff6600":"rgba(255,255,255,0.55)") }}>{value}</span>
    </div>
  );
}
