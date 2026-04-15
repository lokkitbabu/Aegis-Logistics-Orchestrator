import type { WorldState, Asset, Task, Zone, Vec2 } from "./types";
import { computeAssignments, buildRoute, DEFAULT_WEIGHTS } from "./planner";
import type { PlannerWeights, AIPResponse } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function addLog(state: WorldState, msg: string): WorldState {
  return { ...state, log: [...state.log, { tick: state.tick, msg }] };
}

function setAsset(state: WorldState, asset: Asset): WorldState {
  return { ...state, assets: { ...state.assets, [asset.id]: asset } };
}

function setTask(state: WorldState, task: Task): WorldState {
  return { ...state, tasks: { ...state.tasks, [task.id]: task } };
}

// ── Assignment ────────────────────────────────────────────────────────────────

export function assignAsset(
  state: WorldState,
  assetId: string,
  taskId: string,
  weights: PlannerWeights,
  explanation: string
): WorldState {
  const asset = state.assets[assetId];
  const task = state.tasks[taskId];
  const route = buildRoute(state, asset, task);
  if (!route) {
    return addLog(state, `⚠ No route: ${assetId} → ${taskId}`);
  }
  let s = state;
  s = setAsset(s, { ...asset, currentTask: taskId, route, routeIdx: 0, status: "en_route" });
  s = setTask(s, { ...task, status: "assigned", assignedAsset: assetId });
  s = addLog(s, `✓ ${assetId} → ${taskId} | ${explanation}`);
  return s;
}

// ── Planning cycle ────────────────────────────────────────────────────────────

export function runPlanningCycle(
  state: WorldState,
  weights: PlannerWeights,
  getExplanation: (assetId: string, taskId: string) => string = () => "assigned"
): WorldState {
  const assignments = computeAssignments(state, weights);
  let s = state;
  for (const [assetId, taskId] of assignments) {
    const exp = getExplanation(assetId, taskId);
    s = assignAsset(s, assetId, taskId, weights, exp);
  }
  return s;
}

// ── Replanning ────────────────────────────────────────────────────────────────

export function replanAsset(
  state: WorldState,
  assetId: string,
  weights: PlannerWeights,
  reason: string
): WorldState {
  const asset = state.assets[assetId];
  if (!asset.currentTask) return state;
  const task = state.tasks[asset.currentTask];
  const route = buildRoute(state, asset, task);
  if (route) {
    let s = setAsset(state, { ...asset, route, routeIdx: 0 });
    return addLog(s, `↺ ${assetId} rerouted (${reason})`);
  }
  // route failed — release and reassign
  let s = setAsset(state, { ...asset, currentTask: null, route: [], routeIdx: 0, status: "idle" });
  s = setTask(s, { ...task, status: "pending", assignedAsset: null });
  s = addLog(s, `⚠ ${assetId} can't reach ${task.id} (${reason}) — releasing`);
  return runPlanningCycle(s, weights);
}

export function replanAll(state: WorldState, weights: PlannerWeights, reason: string): WorldState {
  let s = addLog(state, `↺ Replanning all assets: ${reason}`);
  for (const asset of Object.values(s.assets)) {
    if (asset.currentTask) s = replanAsset(s, asset.id, weights, reason);
  }
  return s;
}

// ── Simulator tick ────────────────────────────────────────────────────────────

export function simulatorTick(state: WorldState, weights: PlannerWeights): WorldState {
  let s = { ...state, tick: state.tick + 1 };

  for (const asset of Object.values(s.assets)) {
    if (asset.status !== "en_route" || asset.route.length === 0) continue;

    const nextIdx = Math.min(asset.routeIdx + 1, asset.route.length - 1);
    const nextPos = asset.route[nextIdx];
    const drain = asset.type === "drone" ? 1.5 : 0.8;
    const newBattery = Math.max(0, asset.battery - drain);

    let updated: Asset = { ...asset, pos: nextPos, routeIdx: nextIdx, battery: newBattery };

    if (newBattery <= 5) {
      updated = { ...updated, status: "critical", currentTask: null, route: [], routeIdx: 0 };
      s = setAsset(s, updated);
      if (asset.currentTask) {
        const t = s.tasks[asset.currentTask];
        if (t) s = setTask(s, { ...t, status: "pending", assignedAsset: null });
      }
      s = addLog(s, `🔋 ${asset.id} critical battery — mission abort`);
      continue;
    }

    const task = asset.currentTask ? s.tasks[asset.currentTask] : null;
    if (task) {
      if (nextPos[0] === task.pickup[0] && nextPos[1] === task.pickup[1]) {
        s = addLog(s, `📦 ${asset.id} picked up payload`);
      }
      if (nextPos[0] === task.dropoff[0] && nextPos[1] === task.dropoff[1]) {
        updated = { ...updated, currentTask: null, route: [], routeIdx: 0, status: "idle" };
        s = setTask(s, { ...task, status: "complete" });
        s = addLog(s, `✓ ${asset.id} delivered ${task.id} at T${s.tick}`);
      }
    }
    s = setAsset(s, updated);
  }
  return s;
}

// ── AIP response application ──────────────────────────────────────────────────

export function applyAIPResponse(
  state: WorldState,
  response: AIPResponse,
  weights: PlannerWeights,
  setWeights: (w: PlannerWeights) => void
): WorldState {
  if (response.action === "update_constraints" && response.weights) {
    const newW = { ...weights, ...response.weights };
    setWeights(newW);
    let s = addLog(state, `🎯 AIP: ${response.explanation}`);
    return replanAll(s, newW, "operator intent update");
  }

  if (response.action === "override" && response.taskId) {
    const task = state.tasks[response.taskId];
    if (!task) return addLog(state, `⚠ AIP override: task ${response.taskId} not found`);
    let s = state;
    // release current
    if (task.assignedAsset) {
      const a = s.assets[task.assignedAsset];
      if (a) s = setAsset(s, { ...a, currentTask: null, route: [], routeIdx: 0, status: "idle" });
    }
    s = setTask(s, { ...task, status: "pending", assignedAsset: null });

    // force type
    if (response.forceAssetType) {
      const target = Object.values(s.assets).find(
        a => a.type === response.forceAssetType && a.status === "idle"
      );
      if (target) s = assignAsset(s, target.id, task.id, weights, response.explanation);
    } else if (response.forceAssetId) {
      s = assignAsset(s, response.forceAssetId, task.id, weights, response.explanation);
    }
    return addLog(s, `👤 AIP override: ${response.explanation}`);
  }

  return addLog(state, `💬 AIP: ${response.explanation}`);
}

// ── Scenario ──────────────────────────────────────────────────────────────────

export function buildDemoScenario(): WorldState {
  return {
    gridSize: 20,
    tick: 0,
    log: [],
    gpsDenied: [],
    zones: [
      {
        id: "Z_NOGO",
        type: "no_go",
        cells: Array.from({ length: 7 }, (_, i): Vec2 => [10, i + 5]),
        riskScore: 999,
      },
    ],
    assets: {
      D1: { id:"D1", type:"drone",  pos:[2,2],  battery:85, payloadCapacity:5,  currentTask:null, route:[], routeIdx:0, status:"idle" },
      D2: { id:"D2", type:"drone",  pos:[4,17], battery:60, payloadCapacity:5,  currentTask:null, route:[], routeIdx:0, status:"idle" },
      G1: { id:"G1", type:"ground", pos:[1,10], battery:95, payloadCapacity:20, currentTask:null, route:[], routeIdx:0, status:"idle" },
    },
    tasks: {
      T1: { id:"T1", pickup:[5,3],  dropoff:[15,15], priority:5, payloadKg:4,  deadlineTicks:60, status:"pending", assignedAsset:null, createdTick:0 },
      T2: { id:"T2", pickup:[3,14], dropoff:[18,5],  priority:3, payloadKg:15, deadlineTicks:80, status:"pending", assignedAsset:null, createdTick:0 },
    },
  };
}

export function injectThreatZone(state: WorldState): WorldState {
  const cells: Vec2[] = [];
  for (let x=7; x<13; x++) for (let y=7; y<11; y++) cells.push([x,y]);
  const s = { ...state, zones: [...state.zones, { id:"Z_THREAT", type:"threat" as const, cells, riskScore:0.85 }] };
  return addLog(s, "⚠ THREAT ZONE: contested airspace detected (7–12, 7–10)");
}

export function injectGpsDenial(state: WorldState): WorldState {
  const cells: Vec2[] = [];
  for (let x=5; x<14; x++) for (let y=12; y<17; y++) cells.push([x,y]);
  const s = { ...state, gpsDenied: cells };
  return addLog(s, "📡 GPS DEGRADED: sectors (5–13, 12–16) — drone routing penalized");
}

export function addUrgentTask(state: WorldState): WorldState {
  const id = `T${Object.keys(state.tasks).length + 1}`;
  const task: Task = {
    id, pickup:[8,1], dropoff:[17,17],
    priority:5, payloadKg:2,
    deadlineTicks: state.tick + 30,
    status:"pending", assignedAsset:null, createdTick:state.tick
  };
  const s = { ...state, tasks: { ...state.tasks, [id]: task } };
  return addLog(s, `🚨 URGENT ${id}: medical supply — 30-tick deadline, priority 5`);
}
