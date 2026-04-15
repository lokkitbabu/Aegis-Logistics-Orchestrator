import type {
  WorldState, Asset, Task, Zone, Vec2, SupplyNode,
  CargoType, CargoManifest, PlannerWeights, AIPResponse,
} from "./types";
import { CARGO_PRIORITY, DEFAULT_WEIGHTS } from "./types";
import { computeAssignments, buildRoute, buildReturnRoute, routeRiskScore, astar } from "./planner";

// ── State helpers ─────────────────────────────────────────────────────────────
function addLog(s: WorldState, msg: string): WorldState {
  return { ...s, log: [...s.log, { tick: s.tick, msg }] };
}
function setAsset(s: WorldState, a: Asset): WorldState {
  return { ...s, assets: { ...s.assets, [a.id]: a } };
}
function setTask(s: WorldState, t: Task): WorldState {
  return { ...s, tasks: { ...s.tasks, [t.id]: t } };
}
function setNode(s: WorldState, n: SupplyNode): WorldState {
  return { ...s, nodes: { ...s.nodes, [n.id]: n } };
}

// ── Assignment ─────────────────────────────────────────────────────────────────
export function assignAsset(
  state: WorldState, assetId: string, taskId: string,
  weights: PlannerWeights, explanation: string
): WorldState {
  const asset = state.assets[assetId];
  const task  = state.tasks[taskId];
  const route = buildRoute(state, asset, task);
  if (!route) return addLog(state, `⚠ No route: ${assetId} → ${taskId}`);
  const riskScore = routeRiskScore(route, state);
  let s = setAsset(state, { ...asset, currentTask: taskId, route, routeIdx: 0, status: "en_route" });
  s = setTask(s, { ...task, status: "assigned", assignedAsset: assetId, riskScore });
  return addLog(s, `✓ ${assetId} → ${taskId} [risk:${riskScore.toFixed(2)}] | ${explanation}`);
}

export function runPlanningCycle(state: WorldState, weights: PlannerWeights): WorldState {
  const pairs = computeAssignments(state, weights);
  let s = state;
  for (const [aid, tid] of pairs) s = assignAsset(s, aid, tid, weights, "auto-assigned");
  return s;
}

export function replanAsset(state: WorldState, assetId: string, weights: PlannerWeights, reason: string): WorldState {
  const asset = state.assets[assetId];
  if (!asset.currentTask) return state;
  const task = state.tasks[asset.currentTask];
  const route = buildRoute(state, asset, task);
  if (route) {
    let s = setAsset(state, { ...asset, route, routeIdx: 0 });
    return addLog(s, `↺ ${assetId} rerouted (${reason})`);
  }
  let s = setAsset(state, { ...asset, currentTask: null, route: [], routeIdx: 0, status: "idle" });
  s = setTask(s, { ...task, status: "approved", assignedAsset: null });
  s = addLog(s, `⚠ ${assetId} can't reach ${task.id} (${reason}) — releasing`);
  return runPlanningCycle(s, weights);
}

export function replanAll(state: WorldState, weights: PlannerWeights, reason: string): WorldState {
  let s = addLog(state, `↺ Global replan: ${reason}`);
  for (const asset of Object.values(s.assets))
    if (asset.currentTask) s = replanAsset(s, asset.id, weights, reason);
  return s;
}

// ── Approve task ──────────────────────────────────────────────────────────────
export function approveTask(state: WorldState, taskId: string): WorldState {
  const task = state.tasks[taskId];
  if (!task || task.status !== "pending") return state;
  let s = setTask(state, { ...task, status: "approved", approvedTick: state.tick });
  return addLog(s, `✔ Task ${taskId} approved — entering queue`);
}

export function cancelTask(state: WorldState, taskId: string, weights: PlannerWeights): WorldState {
  const task = state.tasks[taskId];
  if (!task) return state;
  let s = state;
  if (task.assignedAsset) {
    const asset = s.assets[task.assignedAsset];
    if (asset) {
      s = setAsset(s, { ...asset, currentTask: null, route: [], routeIdx: 0, status: "idle" });
    }
  }
  s = setTask(s, { ...task, status: "cancelled", assignedAsset: null });
  return addLog(s, `✗ Task ${taskId} cancelled`);
}

// ── Simulator tick ─────────────────────────────────────────────────────────────
export function simulatorTick(state: WorldState, weights: PlannerWeights): WorldState {
  let s = { ...state, tick: state.tick + 1 };

  // Supply consumption at nodes
  for (const node of Object.values(s.nodes)) {
    const updatedInv = { ...node.inventory };
    for (const [cargo, rate] of Object.entries(node.demandPerTick) as [CargoType, number][]) {
      updatedInv[cargo] = Math.max(0, updatedInv[cargo] - rate);
    }
    s = setNode(s, { ...node, inventory: updatedInv });
  }

  // Move assets
  for (const asset of Object.values(s.assets)) {
    if ((asset.status !== "en_route" && asset.status !== "returning") || !asset.route.length) continue;
    const nextIdx = Math.min(asset.routeIdx + 1, asset.route.length - 1);
    const nextPos = asset.route[nextIdx];
    const drain = asset.type === "drone"
      ? 1.2 + state.weather.windSpeed * 0.8
      : 0.6;
    const newBattery = Math.max(0, asset.battery - drain);
    let updated: Asset = { ...asset, pos: nextPos, routeIdx: nextIdx, battery: newBattery };

    if (newBattery <= 8) {
      updated = { ...updated, status: "critical", currentTask: null, route: [], routeIdx: 0 };
      if (asset.currentTask) {
        const t = s.tasks[asset.currentTask];
        if (t) s = setTask(s, { ...t, status: "approved", assignedAsset: null });
      }
      s = addLog(s, `🔋 ${asset.id} CRITICAL battery (${newBattery.toFixed(0)}%) — RTB`);
      s = setAsset(s, updated);
      s = initiateRTB(s, asset.id, weights);
      continue;
    }

    // Check delivery milestones
    const task = asset.currentTask ? s.tasks[asset.currentTask] : null;
    if (task) {
      if (nextPos[0]===task.pickup[0] && nextPos[1]===task.pickup[1]) {
        s = addLog(s, `📦 ${asset.id} loaded cargo at ${task.sourceNodeId}`);
        // Deduct from source node inventory
        const srcNode = Object.values(s.nodes).find(n => n.id===task.sourceNodeId);
        if (srcNode) {
          const inv = { ...srcNode.inventory };
          for (const c of task.cargo) inv[c.type] = Math.max(0, inv[c.type] - c.quantity);
          s = setNode(s, { ...srcNode, inventory: inv });
        }
        updated = { ...updated, cargo: task.cargo, status: "en_route" };
        s = setTask(s, { ...task, status: "in_progress" });
      }
      if (nextPos[0]===task.dropoff[0] && nextPos[1]===task.dropoff[1]) {
        // Deliver to dest node
        const destNode = Object.values(s.nodes).find(n => n.id===task.destNodeId);
        if (destNode) {
          const inv = { ...destNode.inventory };
          for (const c of task.cargo) inv[c.type] = Math.min(destNode.capacity[c.type], inv[c.type]+c.quantity);
          s = setNode(s, { ...destNode, inventory: inv });
        }
        s = setTask(s, { ...task, status: "complete", completedTick: s.tick });
        s = addLog(s, `✓ ${asset.id} delivered ${task.cargo.map(c=>`${c.quantity}x${c.type}`).join(",")} to ${task.destNodeId}`);
        updated = { ...updated, currentTask: null, route: [], routeIdx: 0, cargo: [], status: "idle" };
        // Auto-return to base if battery < 50%
        if (newBattery < 50) {
          s = setAsset(s, updated);
          s = initiateRTB(s, asset.id, weights);
          continue;
        }
      }
    }

    // Returning to base — arrived
    if (asset.status === "returning" && nextPos[0]===asset.route[asset.route.length-1][0] && nextPos[1]===asset.route[asset.route.length-1][1]) {
      const homeNode = s.nodes[asset.homeNodeId];
      updated = { ...updated, status: "recharging", route: [], routeIdx: 0 };
      s = addLog(s, `🔌 ${asset.id} returned to ${homeNode?.name ?? asset.homeNodeId} — recharging`);
    }
    s = setAsset(s, updated);
  }

  // Recharge idle/recharging assets
  for (const asset of Object.values(s.assets)) {
    if (asset.status === "recharging") {
      const newBatt = Math.min(asset.maxBattery, asset.battery + 5);
      const done = newBatt >= asset.maxBattery * 0.9;
      s = setAsset(s, { ...asset, battery: newBatt, status: done ? "idle" : "recharging" });
      if (done) s = addLog(s, `✓ ${asset.id} recharged (${newBatt.toFixed(0)}%) — ready`);
    }
  }

  // Auto-generate resupply tasks from node shortfalls
  s = checkResupplyNeeds(s);

  return s;
}

function initiateRTB(state: WorldState, assetId: string, weights: PlannerWeights): WorldState {
  const asset = state.assets[assetId];
  const route = buildReturnRoute(state, asset);
  if (!route) return addLog(state, `⚠ ${assetId} cannot find RTB route`);
  let s = setAsset(state, { ...asset, status: "returning", route, routeIdx: 0, currentTask: null, cargo: [] });
  return addLog(s, `↩ ${assetId} returning to base`);
}

function checkResupplyNeeds(state: WorldState): WorldState {
  let s = state;
  for (const node of Object.values(s.nodes)) {
    if (node.type === "fob" || node.type === "depot") continue; // depots don't need resupply
    for (const [cargoStr, inv] of Object.entries(node.inventory) as [CargoType, number][]) {
      const cap = node.capacity[cargoStr];
      const ratio = inv / cap;
      if (ratio < node.criticalThreshold) {
        // Check if there's already a pending/active task for this
        const alreadyPending = Object.values(s.tasks).some(
          t => t.destNodeId===node.id && t.cargo.some(c=>c.type===cargoStr)
            && ["pending","approved","assigned","in_progress"].includes(t.status)
        );
        if (!alreadyPending) {
          s = autoGenerateResupplyTask(s, node, cargoStr, Math.floor(cap * 0.6));
        }
      }
    }
  }
  return s;
}

function autoGenerateResupplyTask(
  state: WorldState, destNode: SupplyNode, cargo: CargoType, qty: number
): WorldState {
  // Find best depot with this cargo
  const depot = Object.values(state.nodes)
    .filter(n => n.type==="depot" || n.type==="fob")
    .find(n => n.inventory[cargo] >= qty);
  if (!depot) return state;

  const id = `T${state.taskCounter + 1}`;
  const priority = CARGO_PRIORITY[cargo];
  const weightKg = qty * (cargo==="fuel" ? 5 : cargo==="ammo" ? 3 : 1);
  const cargoManifest: CargoManifest[] = [{ type: cargo, quantity: qty, weightKg }];
  const task: Task = {
    id, sourceNodeId: depot.id, destNodeId: destNode.id,
    pickup: depot.pos, dropoff: destNode.pos,
    priority, cargo: cargoManifest, totalWeightKg: weightKg,
    deadlineTicks: state.tick + 60,
    status: "pending", assignedAsset: null,
    createdTick: state.tick, approvedTick: null, completedTick: null,
    riskScore: 0,
  };
  let s = { ...state, tasks: { ...state.tasks, [id]: task }, taskCounter: state.taskCounter + 1 };
  const emoji = cargo==="medevac"?"🚨":cargo==="ammo"?"💥":cargo==="fuel"?"⛽":"📦";
  return addLog(s, `${emoji} AUTO-TASK ${id}: ${depot.name} → ${destNode.name} [${qty}x ${cargo}] P${priority} — AWAITING APPROVAL`);
}

// ── AIP response application ──────────────────────────────────────────────────
export function applyAIPResponse(
  state: WorldState, response: AIPResponse,
  weights: PlannerWeights, setWeights: (w: PlannerWeights) => void
): WorldState {
  if (response.action === "update_constraints" && response.weights) {
    const nw = { ...weights, ...response.weights };
    setWeights(nw);
    let s = addLog(state, `🎯 AIP: ${response.explanation}`);
    return replanAll(s, nw, "AIP constraint update");
  }
  if (response.action === "override" && response.taskId) {
    let s = state;
    const task = s.tasks[response.taskId];
    if (!task) return addLog(s, `⚠ AIP override: task ${response.taskId} not found`);
    if (task.assignedAsset) {
      const a = s.assets[task.assignedAsset];
      if (a) s = setAsset(s, { ...a, currentTask: null, route: [], routeIdx: 0, status: "idle" });
    }
    s = setTask(s, { ...task, status: "approved", assignedAsset: null });
    if (response.forceAssetType) {
      const target = Object.values(s.assets).find(a=>a.type===response.forceAssetType && a.status==="idle");
      if (target) s = assignAsset(s, target.id, task.id, weights, response.explanation);
    } else if (response.forceAssetId) {
      s = assignAsset(s, response.forceAssetId, task.id, weights, response.explanation);
    }
    return addLog(s, `👤 AIP override: ${response.explanation}`);
  }
  if (response.action === "suggest_mission" && response.suggestedMission) {
    const m = response.suggestedMission;
    const src = state.nodes[m.sourceNodeId];
    const dst = state.nodes[m.destNodeId];
    if (!src || !dst) return addLog(state, `⚠ AIP suggestion: invalid nodes`);
    const id = `T${state.taskCounter + 1}`;
    const weightKg = m.quantity * 2;
    const cargo: CargoManifest[] = [{ type: m.cargoType, quantity: m.quantity, weightKg }];
    const task: Task = {
      id, sourceNodeId: src.id, destNodeId: dst.id,
      pickup: src.pos, dropoff: dst.pos,
      priority: m.priority, cargo, totalWeightKg: weightKg,
      deadlineTicks: state.tick + 80,
      status: "pending", assignedAsset: null,
      createdTick: state.tick, approvedTick: null, completedTick: null,
      riskScore: 0,
    };
    let s = { ...state, tasks: { ...state.tasks, [id]: task }, taskCounter: state.taskCounter + 1 };
    return addLog(s, `💬 AIP suggested mission ${id}: ${response.explanation}`);
  }
  return addLog(state, `💬 AIP: ${response.explanation}`);
}

// ── Scenario ──────────────────────────────────────────────────────────────────
function makeNode(id: string, name: string, pos: Vec2, type: SupplyNode["type"],
  inv: Partial<Record<CargoType,number>> = {}, demand: Partial<Record<CargoType,number>> = {},
  criticalThreshold = 0.25
): SupplyNode {
  const full = (v: number) => ({ medevac: v, ammo: v, food: v, equipment: v, fuel: v });
  return {
    id, name, pos, type,
    inventory: { ...full(0), ...inv } as Record<CargoType,number>,
    capacity:  full(100) as Record<CargoType,number>,
    demandPerTick: { ...full(0), ...demand } as Record<CargoType,number>,
    criticalThreshold,
  };
}

export function buildDemoScenario(): WorldState {
  const nodes: Record<string, SupplyNode> = {
    N_FOB_ALPHA: makeNode("N_FOB_ALPHA", "FOB Alpha",    [2, 2],   "fob",
      { medevac:80, ammo:90, food:85, fuel:75, equipment:70 }, {}),
    N_DEPOT_B:   makeNode("N_DEPOT_B",   "Depot Bravo",  [10, 1],  "depot",
      { medevac:100,ammo:100,food:100,fuel:100,equipment:100 }, {}),
    N_OUT_C:     makeNode("N_OUT_C",     "Outpost Charlie", [17,15], "outpost",
      { medevac:40, ammo:55, food:60, fuel:50, equipment:45 },
      { ammo:0.3, food:0.2, fuel:0.4 }, 0.3),
    N_OUT_D:     makeNode("N_OUT_D",     "Outpost Delta",  [15, 5], "outpost",
      { medevac:30, ammo:65, food:70, fuel:55, equipment:50 },
      { medevac:0.1, ammo:0.25, food:0.15 }, 0.3),
    N_LZ_ECHO:   makeNode("N_LZ_ECHO",   "LZ Echo",       [3, 15], "lz",
      { medevac:20, ammo:30, food:40, fuel:25, equipment:35 },
      { food:0.1, equipment:0.1 }, 0.2),
  };

  return {
    gridSize: 20,
    tick: 0, taskCounter: 0,
    log: [],
    gpsDenied: [],
    weather: { windVec: [0.3, -0.1], windSpeed: 0.2, visibility: 1.0 },
    zones: [
      {
        id: "Z_NOGO",
        type: "no_go",
        cells: Array.from({ length: 7 }, (_, i): Vec2 => [10, i + 5]),
        riskScore: 999,
      },
    ],
    nodes,
    assets: {
      D1: { id:"D1", type:"drone",  homeNodeId:"N_FOB_ALPHA", pos:[2,2],  battery:85, maxBattery:100, payloadCapacity:10, currentTask:null, route:[], routeIdx:0, status:"idle", cargo:[] },
      D2: { id:"D2", type:"drone",  homeNodeId:"N_DEPOT_B",   pos:[10,1], battery:90, maxBattery:100, payloadCapacity:10, currentTask:null, route:[], routeIdx:0, status:"idle", cargo:[] },
      G1: { id:"G1", type:"ground", homeNodeId:"N_FOB_ALPHA", pos:[2,3],  battery:95, maxBattery:100, payloadCapacity:30, currentTask:null, route:[], routeIdx:0, status:"idle", cargo:[] },
    },
    tasks: {},
  };
}

export function injectThreatZone(state: WorldState): WorldState {
  const cells: Vec2[] = [];
  for (let x=7; x<13; x++) for (let y=7; y<11; y++) cells.push([x,y]);
  const s = { ...state, zones: [...state.zones, { id:`Z_THREAT_${state.tick}`, type:"threat" as const, cells, riskScore:0.85 }] };
  return addLog(s, "⚠ THREAT ZONE: contested airspace (7–12, 7–10)");
}

export function injectGpsDenial(state: WorldState): WorldState {
  const cells: Vec2[] = [];
  for (let x=5; x<14; x++) for (let y=12; y<17; y++) cells.push([x,y]);
  return addLog({ ...state, gpsDenied: [...state.gpsDenied, ...cells] },
    "📡 GPS DEGRADED: sectors (5–13, 12–16)");
}

export function addUrgentTask(state: WorldState): WorldState {
  const id = `T${state.taskCounter + 1}`;
  const task: Task = {
    id,
    sourceNodeId: "N_DEPOT_B", destNodeId: "N_OUT_C",
    pickup: [10,1], dropoff: [17,15],
    priority: 5,
    cargo: [{ type: "medevac", quantity: 3, weightKg: 6 }],
    totalWeightKg: 6,
    deadlineTicks: state.tick + 25,
    status: "approved",
    assignedAsset: null,
    createdTick: state.tick, approvedTick: state.tick, completedTick: null,
    riskScore: 0,
  };
  let s = { ...state, tasks: { ...state.tasks, [id]: task }, taskCounter: state.taskCounter + 1 };
  return addLog(s, `🚨 URGENT MEDEVAC ${id}: Depot Bravo → Outpost Charlie — auto-approved`);
}

export function deteriorateWeather(state: WorldState): WorldState {
  const weather = { windVec: [0.8, 0.4] as Vec2, windSpeed: 0.75, visibility: 0.6 };
  let s = { ...state, weather };
  s = addLog(s, "🌪 WEATHER DETERIORATED: high winds — drone range reduced 40%");
  return replanAll(s, DEFAULT_WEIGHTS, "weather degradation");
}
