import type { Vec2, Asset, Task, WorldState, PlannerWeights } from "./types";

// ── A* ───────────────────────────────────────────────────────────────────────

function key(p: Vec2) { return `${p[0]},${p[1]}`; }
function h(a: Vec2, b: Vec2) { return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]); }

function neighbors(pos: Vec2, G: number): Vec2[] {
  const [x, y] = pos;
  return ([ [-1,0],[1,0],[0,-1],[0,1] ] as [number,number][])
    .map(([dx,dy]): Vec2 => [x+dx, y+dy])
    .filter(([nx,ny]) => nx>=0 && nx<G && ny>=0 && ny<G);
}

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

export function astar(
  state: WorldState,
  start: Vec2,
  goal: Vec2,
  asset: Asset
): Vec2[] | null {
  const G = state.gridSize;
  const open = new Map<string, { g: number; f: number; pos: Vec2 }>();
  const cameFrom = new Map<string, string | null>();
  const gScore = new Map<string, number>();

  const startKey = key(start);
  gScore.set(startKey, 0);
  open.set(startKey, { g: 0, f: h(start, goal), pos: start });
  cameFrom.set(startKey, null);

  while (open.size > 0) {
    // pick lowest f
    let curKey = "";
    let minF = Infinity;
    for (const [k, v] of open) { if (v.f < minF) { minF = v.f; curKey = k; } }

    const { pos: cur, g } = open.get(curKey)!;
    open.delete(curKey);

    if (cur[0] === goal[0] && cur[1] === goal[1]) {
      const path: Vec2[] = [];
      let k: string | null = curKey;
      while (k !== null) {
        const [px, py] = k.split(",").map(Number);
        path.unshift([px, py]);
        k = cameFrom.get(k) ?? null;
      }
      return path;
    }

    for (const nb of neighbors(cur, G)) {
      const risk = zoneRisk(nb, state);
      if (risk >= 999) continue;
      const gpsPen = (isGpsDenied(nb, state) && asset.type === "drone") ? 3 : 0;
      const edgeCost = 1 + risk * 2 + gpsPen;
      const ng = g + edgeCost;
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

// ── Planner ───────────────────────────────────────────────────────────────────

export const DEFAULT_WEIGHTS: PlannerWeights = {
  travel: 1.0,
  risk: 2.0,
  battery: 1.5,
  lateness: 3.0,
  priority: 2.0,
};

function scoreAssignment(
  asset: Asset, task: Task, state: WorldState, w: PlannerWeights
): number {
  if (task.payloadKg > asset.payloadCapacity) return Infinity;
  const path = astar(state, asset.pos, task.pickup, asset);
  if (!path) return Infinity;
  const travelCost = path.length;
  const batteryNeeded = travelCost * (asset.type === "drone" ? 2 : 1);
  if (batteryNeeded > asset.battery) return Infinity;
  const routeRisk = path.reduce((s, p) => s + zoneRisk(p, state), 0) / Math.max(path.length, 1);
  const late = Math.max(0, travelCost - (task.deadlineTicks - state.tick));
  return (
    w.travel * travelCost +
    w.risk * routeRisk * 10 +
    w.battery * batteryNeeded +
    w.lateness * late -
    w.priority * task.priority * 5
  );
}

export function computeAssignments(
  state: WorldState,
  weights: PlannerWeights
): Array<[string, string]> {
  const pending = Object.values(state.tasks).filter(t => t.status === "pending");
  const idle = Object.values(state.assets).filter(a => a.status === "idle" && !a.currentTask);
  const usedAssets = new Set<string>();
  const assignments: Array<[string, string]> = [];

  for (const task of [...pending].sort((a, b) => b.priority - a.priority)) {
    let best = Infinity, bestAsset: Asset | null = null;
    for (const asset of idle) {
      if (usedAssets.has(asset.id)) continue;
      const s = scoreAssignment(asset, task, state, weights);
      if (s < best) { best = s; bestAsset = asset; }
    }
    if (bestAsset) {
      assignments.push([bestAsset.id, task.id]);
      usedAssets.add(bestAsset.id);
    }
  }
  return assignments;
}

export function buildRoute(state: WorldState, asset: Asset, task: Task): Vec2[] | null {
  const toPickup = astar(state, asset.pos, task.pickup, asset);
  if (!toPickup) return null;
  const toDropoff = astar(state, task.pickup, task.dropoff, asset);
  if (!toDropoff) return null;
  return [...toPickup, ...toDropoff.slice(1)];
}
