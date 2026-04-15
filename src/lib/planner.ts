import type { Vec2, Asset, Task, WorldState, PlannerWeights } from "./types";
export { DEFAULT_WEIGHTS } from "./types";

function key(p: Vec2) { return `${p[0]},${p[1]}`; }
function h(a: Vec2, b: Vec2) { return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]); }

function zoneRisk(pos: Vec2, state: WorldState): number {
  for (const z of state.zones) {
    if (z.cells.some(c => c[0]===pos[0] && c[1]===pos[1])) {
      if (z.type === "no_go") return 999;
      return z.riskScore;
    }
  }
  return 0;
}

function isGpsDenied(pos: Vec2, state: WorldState): boolean {
  return state.gpsDenied.some(c => c[0]===pos[0] && c[1]===pos[1]);
}

export function astar(state: WorldState, start: Vec2, goal: Vec2, asset: Asset): Vec2[] | null {
  const G = state.gridSize;
  const open = new Map<string, { g: number; f: number; pos: Vec2 }>();
  const cameFrom = new Map<string, string | null>();
  const gScore = new Map<string, number>();
  const sk = key(start);
  gScore.set(sk, 0);
  open.set(sk, { g: 0, f: h(start, goal), pos: start });
  cameFrom.set(sk, null);

  while (open.size > 0) {
    let curKey = ""; let minF = Infinity;
    for (const [k, v] of open) { if (v.f < minF) { minF = v.f; curKey = k; } }
    const { pos: cur, g } = open.get(curKey)!;
    open.delete(curKey);
    if (cur[0]===goal[0] && cur[1]===goal[1]) {
      const path: Vec2[] = [];
      let k: string|null = curKey;
      while (k!==null) { const [px,py]=k.split(",").map(Number); path.unshift([px,py]); k=cameFrom.get(k)??null; }
      return path;
    }
    const [x,y]=cur;
    for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]] as [number,number][]) {
      const nb: Vec2 = [x+dx, y+dy];
      if (nb[0]<0||nb[0]>=G||nb[1]<0||nb[1]>=G) continue;
      const risk = zoneRisk(nb, state);
      if (risk>=999) continue;
      // Wind penalty for drones
      let windPen = 0;
      if (asset.type==="drone" && state.weather.windSpeed > 0.5) {
        const [wx,wy] = state.weather.windVec;
        windPen = (dx*wx + dy*wy) < 0 ? state.weather.windSpeed * 2 : 0;
      }
      const gpsPen = (isGpsDenied(nb,state) && asset.type==="drone") ? 3 : 0;
      const ng = g + 1 + risk*2 + gpsPen + windPen;
      const nbKey = key(nb);
      if (ng < (gScore.get(nbKey) ?? Infinity)) {
        gScore.set(nbKey, ng);
        cameFrom.set(nbKey, curKey);
        open.set(nbKey, { g: ng, f: ng + h(nb, goal), pos: nb });
      }
    }
  }
  return null;
}

export function routeRiskScore(route: Vec2[], state: WorldState): number {
  if (!route.length) return 0;
  return route.reduce((s, p) => s + zoneRisk(p, state), 0) / route.length;
}

export function buildRoute(state: WorldState, asset: Asset, task: Task): Vec2[] | null {
  const toPickup = astar(state, asset.pos, task.pickup, asset);
  if (!toPickup) return null;
  const toDropoff = astar(state, task.pickup, task.dropoff, asset);
  if (!toDropoff) return null;
  return [...toPickup, ...toDropoff.slice(1)];
}

export function buildReturnRoute(state: WorldState, asset: Asset): Vec2[] | null {
  const home = state.nodes[asset.homeNodeId];
  if (!home) return null;
  return astar(state, asset.pos, home.pos, asset);
}

export function scoreAssignment(asset: Asset, task: Task, state: WorldState, w: PlannerWeights): number {
  if (task.totalWeightKg > asset.payloadCapacity) return Infinity;
  const path = astar(state, asset.pos, task.pickup, asset);
  if (!path) return Infinity;
  const travelCost = path.length;
  const battNeeded = travelCost * (asset.type==="drone" ? 1.8 : 0.9);
  if (battNeeded > asset.battery * 0.85) return Infinity; // keep 15% reserve for RTB
  const risk = routeRiskScore(path, state);
  const late = Math.max(0, travelCost - (task.deadlineTicks - state.tick));
  const cargoPriority = task.cargo.reduce((sum, c) => sum + c.quantity, 0);
  return (
    w.travel * travelCost
    + w.risk * risk * 10
    + w.battery * battNeeded
    + w.lateness * late
    - w.priority * task.priority * 5
    - w.cargo * cargoPriority
  );
}

export function computeAssignments(state: WorldState, weights: PlannerWeights): [string, string][] {
  const pending = Object.values(state.tasks).filter(t => t.status==="approved");
  const idle = Object.values(state.assets).filter(a => a.status==="idle" && !a.currentTask);
  const usedAssets = new Set<string>();
  const result: [string, string][] = [];
  for (const task of [...pending].sort((a,b) => b.priority - a.priority)) {
    let best = Infinity, bestAsset: Asset|null = null;
    for (const asset of idle) {
      if (usedAssets.has(asset.id)) continue;
      const s = scoreAssignment(asset, task, state, weights);
      if (s < best) { best = s; bestAsset = asset; }
    }
    if (bestAsset) { result.push([bestAsset.id, task.id]); usedAssets.add(bestAsset.id); }
  }
  return result;
}
