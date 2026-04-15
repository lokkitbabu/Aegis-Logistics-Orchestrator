import type {
  SystemState, CountyData, NWSAlert, FEMADeclaration, Hospital,
  ResponseResource, ResponseTask, ScoringWeights, LogEntry,
  TaskType, ResourceType, AlertLevel, ShortfallAnalysis,
} from "./types";
import { ALERT_ORDER, DEFAULT_WEIGHTS } from "./types";

// ── Logging ────────────────────────────────────────────────────────────────────
function addLog(s: SystemState, level: LogEntry["level"], message: string): SystemState {
  const entry: LogEntry = { id:`L${s.logCounter+1}`, timestamp:new Date().toISOString(), level, message };
  return { ...s, log:[...s.log.slice(-199), entry], logCounter:s.logCounter+1 };
}

// ── Risk Scoring ──────────────────────────────────────────────────────────────
export function computeAlertLevel(alerts: NWSAlert[]): AlertLevel {
  if (!alerts.length) return "none";
  const levels = alerts.map(a=>a.level);
  if (levels.includes("emergency")) return "emergency";
  if (levels.includes("warning")) return "warning";
  if (levels.includes("watch")) return "watch";
  if (levels.includes("advisory")) return "advisory";
  return "none";
}

export function alertLevelScore(level: AlertLevel): number {
  return { none:0, advisory:0.25, watch:0.5, warning:0.8, emergency:1.0 }[level] ?? 0;
}

export function computeVulnerability(c: CountyData): number {
  if (!c.population) return 0;
  const elderly  = Math.min(1, c.elderlyPct / 20);   // >20% elderly = max
  const noVehicle= Math.min(1, c.noVehiclePct / 15);  // >15% no vehicle = max
  const poverty  = Math.min(1, c.povertyPct / 25);    // >25% poverty = max
  return (elderly*0.4 + noVehicle*0.3 + poverty*0.3);
}

export function computeRiskScore(county: CountyData, weights: ScoringWeights, maxPop: number): number {
  const weatherScore   = alertLevelScore(county.alertLevel) * weights.weatherSeverity;
  const femaScore      = (county.hasDeclaration ? 0.9 : 0) * weights.femaDeclaration;
  const popScore       = Math.min(1, county.population / maxPop) * weights.populationExposure;
  const vulnScore      = county.vulnerabilityScore * weights.vulnerability;
  const facilityScore  = Math.min(1, county.hospitals.length / 5) * weights.criticalFacility;
  return Math.min(1, weatherScore + femaScore + popScore + vulnScore + facilityScore);
}

export function recomputeAllRiskScores(state: SystemState): SystemState {
  const maxPop = Math.max(1, ...Object.values(state.counties).map(c=>c.population));
  const updated: Record<string, CountyData> = {};
  for (const [fips, c] of Object.entries(state.counties)) {
    const alertLevel = computeAlertLevel(c.alerts);
    const vulnerability = computeVulnerability({...c, alertLevel});
    const riskScore = computeRiskScore({...c, alertLevel, vulnerabilityScore:vulnerability}, state.weights, maxPop);
    const impactedPop = Math.round(c.population * Math.min(1, riskScore * 1.5));
    updated[fips] = { ...c, alertLevel, vulnerabilityScore:vulnerability, riskScore, impactedPopulation:impactedPop };
  }
  // Rank by risk score
  const sorted = Object.values(updated).sort((a,b)=>b.riskScore-a.riskScore);
  sorted.forEach((c,i) => { updated[c.fips] = {...updated[c.fips], riskRank:i+1}; });
  return {...state, counties:updated};
}

// ── Task Generation ────────────────────────────────────────────────────────────
export function autoGenerateTasks(state: SystemState): SystemState {
  let s = state;
  for (const county of Object.values(s.counties)) {
    const score = county.riskScore;
    const existing = Object.values(s.tasks).filter(t=>t.targetFips===county.fips&&!["complete","cancelled"].includes(t.status));

    // Rule 1: High risk → damage assessment
    if (score > 0.55 && !existing.some(t=>t.type==="damage_assessment")) {
      s = createTask(s, "damage_assessment", county.fips, county.name, score, county.alerts[0]?.event||"elevated risk score");
    }
    // Rule 2: Hospital + warning → facility check
    if (county.hospitals.length>0 && ALERT_ORDER[county.alertLevel]>=2 && !existing.some(t=>t.type==="facility_check")) {
      s = createTask(s, "facility_check", county.fips, county.name, score+0.2, `${county.hospitals.length} hospital(s) in active ${county.alertLevel} zone`);
    }
    // Rule 3: Vulnerable + hazard → shelter support
    if (county.vulnerabilityScore>0.5 && score>0.45 && !existing.some(t=>t.type==="shelter_support")) {
      s = createTask(s, "shelter_support", county.fips, county.name, score*0.9, `vulnerability score ${(county.vulnerabilityScore*100).toFixed(0)}% with active hazard`);
    }
    // Rule 4: Multiple high-risk counties → resource staging
    const highRiskNeighbors = Object.values(s.counties).filter(c=>c.fips!==county.fips&&c.riskScore>0.65).length;
    if (highRiskNeighbors>=2 && score>0.65 && !existing.some(t=>t.type==="resource_staging")) {
      s = createTask(s, "resource_staging", county.fips, county.name, score+0.1, `${highRiskNeighbors} high-risk counties in region`);
    }
    // Rule 5: Emergency alert → evacuation
    if (county.alertLevel==="emergency" && !existing.some(t=>t.type==="evacuation_support")) {
      s = createTask(s, "evacuation_support", county.fips, county.name, 1.0, "EMERGENCY alert level requires evacuation coordination");
    }
  }
  return s;
}

function createTask(state: SystemState, type: TaskType, fips: string, name: string, priority: number, trigger: string): SystemState {
  const id = `T${String(state.taskCounter+1).padStart(3,"0")}`;
  const titles: Record<TaskType,string> = {
    damage_assessment:`Damage Assessment — ${name}`,
    facility_check:`Critical Facility Check — ${name}`,
    shelter_support:`Shelter Support — ${name}`,
    resource_staging:`Resource Staging — ${name}`,
    evacuation_support:`Evacuation Coordination — ${name}`,
  };
  const compat: Record<TaskType, ResourceType[]> = {
    damage_assessment:["assessment_crew"],
    facility_check:["assessment_crew","medical_team"],
    shelter_support:["shelter_team","supply_truck"],
    resource_staging:["supply_truck","generator_team"],
    evacuation_support:["shelter_team","assessment_crew","medical_team"],
  };
  const hours: Record<TaskType,number> = { damage_assessment:12, facility_check:6, shelter_support:24, resource_staging:8, evacuation_support:4 };
  const task: ResponseTask = {
    id, type, title:titles[type], targetFips:fips, targetName:name,
    priorityScore:Math.min(100, Math.round(priority*100)),
    status:"pending", assignedResourceId:null,
    triggerReason:trigger, description:`Auto-generated: ${trigger}`,
    createdAt:new Date().toISOString(), deadlineHours:hours[type],
    compatibleTypes:compat[type],
  };
  const s = {...state, tasks:{...state.tasks,[id]:task}, taskCounter:state.taskCounter+1};
  return addLog(s,"warning",`📋 Task ${id} created: ${titles[type]} [P${task.priorityScore}] — ${trigger}`);
}

// ── Resource Assignment ────────────────────────────────────────────────────────
function distanceBetweenFips(a: string, b: string, counties: Record<string,CountyData>): number {
  // Simple proxy using FIPS numeric distance (real system would use centroids)
  return Math.abs(parseInt(a.slice(2)) - parseInt(b.slice(2))) * 0.1;
}

function assignmentScore(task: ResponseTask, resource: ResponseResource): number {
  if (!task.compatibleTypes.includes(resource.type)) return -Infinity;
  const typeMult = resource.type === "medical_team" && task.type === "facility_check" ? 4 : 2;
  const dist = Math.abs(parseInt(resource.baseFips.slice(2)) - parseInt(task.targetFips.slice(2))) * 0.05;
  return task.priorityScore * 0.04 * 3 - dist - 0 + typeMult;
}

export function runAssignmentCycle(state: SystemState): SystemState {
  let s = state;
  const pendingTasks = Object.values(s.tasks).filter(t=>t.status==="pending").sort((a,b)=>b.priorityScore-a.priorityScore);
  const availableResources = Object.values(s.resources).filter(r=>r.status==="available");

  for (const task of pendingTasks) {
    let best: ResponseResource | null = null; let bestScore = -Infinity;
    for (const r of availableResources) {
      if (r.assignedTaskId) continue;
      const sc = assignmentScore(task, r);
      if (sc > bestScore) { bestScore = sc; best = r; }
    }
    if (best && bestScore > -Infinity) {
      s = {
        ...s,
        tasks: {...s.tasks, [task.id]:{...task, status:"assigned", assignedResourceId:best.id}},
        resources: {...s.resources, [best.id]:{...best, status:"deployed", assignedTaskId:task.id, assignedFips:task.targetFips}},
      };
      s = addLog(s,"action",`✓ ${best.label} → ${task.title} [score:${bestScore.toFixed(1)}, P${task.priorityScore}]`);
    }
  }

  // Shortfall analysis
  s = computeShortfall(s);
  return s;
}

function computeShortfall(state: SystemState): SystemState {
  const high = Object.values(state.tasks).filter(t=>t.priorityScore>=60&&!["complete","cancelled"].includes(t.status));
  const covered = high.filter(t=>t.assignedResourceId);
  const uncovered = high.filter(t=>!t.assignedResourceId);
  const byType: Partial<Record<ResourceType,number>> = {};
  for (const t of uncovered) {
    for (const rt of t.compatibleTypes) byType[rt]=(byType[rt]??0)+1;
  }
  const summary = uncovered.length===0
    ? `All ${high.length} high-priority tasks are covered.`
    : `${uncovered.length} of ${high.length} high-priority tasks UNASSIGNED. Additional ${Object.entries(byType).map(([t,n])=>`${n}× ${t.replace("_"," ")}`).join(", ")} needed.`;
  return {...state, shortfallAnalysis:{
    highPriorityTasks:high.length, coveredTasks:covered.length,
    uncoveredTasks:uncovered.length, uncoveredFips:uncovered.map(t=>t.targetFips),
    shortfallByType:byType, summary,
  }};
}

// ── Data Integration ──────────────────────────────────────────────────────────
export function ingestAlerts(state: SystemState, alerts: NWSAlert[]): SystemState {
  let s = {...state, alerts};
  // Attach alerts to counties
  const counties = {...s.counties};
  for (const c of Object.values(counties)) counties[c.fips] = {...c, alerts:[]};
  for (const alert of alerts) {
    for (const fips of alert.affectedCountyFips) {
      if (counties[fips]) counties[fips] = {...counties[fips], alerts:[...counties[fips].alerts, alert]};
    }
  }
  s = {...s, counties};
  s = recomputeAllRiskScores(s);
  s = autoGenerateTasks(s);
  s = runAssignmentCycle(s);
  const n = alerts.length;
  return addLog(s,"warning",`🌩 NWS: ${n} active alert${n!==1?"s":""} ingested for Georgia`);
}

export function ingestDeclarations(state: SystemState, declarations: FEMADeclaration[]): SystemState {
  let s = {...state, declarations};
  const counties = {...s.counties};
  for (const c of Object.values(counties)) counties[c.fips] = {...c, declarations:[], hasDeclaration:false};
  for (const d of declarations) {
    if (counties[d.countyFips]) counties[d.countyFips] = {
      ...counties[d.countyFips],
      declarations:[...counties[d.countyFips].declarations, d],
      hasDeclaration:true,
    };
  }
  s = {...s, counties, freshness:{...s.freshness, fema:new Date().toISOString()}};
  s = recomputeAllRiskScores(s);
  return addLog(s,"info",`📋 FEMA: ${declarations.length} declarations loaded for Georgia`);
}

export function ingestCensus(state: SystemState, data: Partial<Record<string, Partial<CountyData>>>): SystemState {
  const counties = {...state.counties};
  for (const [fips, census] of Object.entries(data)) {
    if (counties[fips]) counties[fips] = {...counties[fips], ...census};
    else counties[fips] = { fips, name:"Unknown", state:"GA", population:0, elderlyCount:0, noVehicleHouseholds:0, povertyCount:0, elderlyPct:0, noVehiclePct:0, povertyPct:0, vulnerabilityScore:0, alertLevel:"none", alerts:[], hasDeclaration:false, declarations:[], hospitals:[], riskScore:0, riskRank:0, impactedPopulation:0, ...census } as CountyData;
  }
  let s: SystemState = {...state, counties, freshness:{...state.freshness, census:new Date().toISOString()}} as SystemState;
  s = recomputeAllRiskScores(s);
  return addLog(s,"info",`📊 Census: ACS demographics loaded for ${Object.keys(data).length} counties`);
}

export function ingestHospitals(state: SystemState, hospitals: Hospital[]): SystemState {
  const counties = {...state.counties};
  for (const c of Object.values(counties)) counties[c.fips] = {...c, hospitals:[]};
  for (const h of hospitals) {
    if (counties[h.countyFips]) counties[h.countyFips] = {...counties[h.countyFips], hospitals:[...counties[h.countyFips].hospitals, h]};
  }
  let s: SystemState = {...state, hospitals, counties, freshness:{...state.freshness, hospitals:new Date().toISOString()}} as SystemState;
  s = recomputeAllRiskScores(s);
  return addLog(s,"info",`🏥 HIFLD: ${hospitals.length} hospitals loaded across Georgia`);
}

// ── Weights / Override ─────────────────────────────────────────────────────────
export function applyWeightOverride(state: SystemState, overrides: Partial<ScoringWeights>): SystemState {
  const weights = {...state.weights, ...overrides};
  let s = {...state, weights};
  s = recomputeAllRiskScores(s);
  s = autoGenerateTasks(s);
  s = runAssignmentCycle(s);
  return addLog(s,"action",`🎯 Weights updated: ${Object.entries(overrides).map(([k,v])=>`${k}=${v}`).join(", ")}`);
}

export function cancelTask(state: SystemState, taskId: string): SystemState {
  const task = state.tasks[taskId]; if (!task) return state;
  let s = {...state, tasks:{...state.tasks, [taskId]:{...task, status:"cancelled" as const}}};
  if (task.assignedResourceId) {
    const r = s.resources[task.assignedResourceId];
    if (r) s = {...s, resources:{...s.resources, [r.id]:{...r, status:"available" as const, assignedTaskId:null, assignedFips:null}}};
  }
  return addLog(s,"action",`✗ Task ${taskId} cancelled`);
}

export function approveTask(state: SystemState, taskId: string): SystemState {
  const task = state.tasks[taskId]; if (!task) return state;
  const s = {...state, tasks:{...state.tasks, [taskId]:{...task, status:"in_progress" as const}}};
  return addLog(s,"action",`▶ Task ${taskId} approved — in progress`);
}

// ── Initial state ─────────────────────────────────────────────────────────────
export function buildInitialState(): SystemState {
  return {
    counties:{}, alerts:[], declarations:[], hospitals:[],
    countyGeoJSON:null,
    resources: buildDefaultResources(),
    tasks:{},
    freshness:{nws:null,fema:null,census:null,hospitals:null},
    taskCounter:0, logCounter:0,
    log:[{id:"L0",timestamp:new Date().toISOString(),level:"info",message:"System initialized — fetching live data from NWS, FEMA, Census, and HIFLD..."}],
    weights:{...DEFAULT_WEIGHTS},
    isLoading:true,
    loadingStage:"Initializing...",
    shortfallAnalysis:null,
  };
}

function buildDefaultResources(): Record<string,ResponseResource> {
  const resources: ResponseResource[] = [
    // Atlanta metro
    {id:"R001",type:"assessment_crew",label:"Crew Alpha",baseFips:"13121",baseName:"Fulton Co.",capacity:1,status:"available",assignedTaskId:null,assignedFips:null,lat:33.749,lng:-84.388},
    {id:"R002",type:"assessment_crew",label:"Crew Bravo",baseFips:"13089",baseName:"DeKalb Co.",capacity:1,status:"available",assignedTaskId:null,assignedFips:null,lat:33.769,lng:-84.291},
    {id:"R003",type:"generator_team",label:"Gen Team 1",baseFips:"13121",baseName:"Fulton Co.",capacity:3,status:"available",assignedTaskId:null,assignedFips:null,lat:33.760,lng:-84.420},
    {id:"R004",type:"generator_team",label:"Gen Team 2",baseFips:"13067",baseName:"Cobb Co.",capacity:3,status:"available",assignedTaskId:null,assignedFips:null,lat:33.941,lng:-84.457},
    {id:"R005",type:"shelter_team",label:"Shelter Team A",baseFips:"13135",baseName:"Gwinnett Co.",capacity:200,status:"available",assignedTaskId:null,assignedFips:null,lat:33.980,lng:-84.022},
    {id:"R006",type:"supply_truck",label:"Supply Truck 1",baseFips:"13153",baseName:"Houston Co.",capacity:5,status:"available",assignedTaskId:null,assignedFips:null,lat:32.614,lng:-83.728},
    {id:"R007",type:"supply_truck",label:"Supply Truck 2",baseFips:"13051",baseName:"Chatham Co.",capacity:5,status:"available",assignedTaskId:null,assignedFips:null,lat:32.082,lng:-81.099},
    {id:"R008",type:"medical_team",label:"Med Team 1",baseFips:"13121",baseName:"Fulton Co.",capacity:1,status:"available",assignedTaskId:null,assignedFips:null,lat:33.745,lng:-84.395},
    {id:"R009",type:"assessment_crew",label:"Crew Charlie",baseFips:"13051",baseName:"Chatham Co.",capacity:1,status:"available",assignedTaskId:null,assignedFips:null,lat:32.075,lng:-81.100},
    {id:"R010",type:"shelter_team",label:"Shelter Team B",baseFips:"13029",baseName:"Bryan Co.",capacity:150,status:"available",assignedTaskId:null,assignedFips:null,lat:32.061,lng:-81.440},
  ];
  return Object.fromEntries(resources.map(r=>[r.id,r]));
}
