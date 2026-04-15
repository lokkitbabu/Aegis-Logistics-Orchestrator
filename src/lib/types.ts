export type Vec2 = [number, number];

export type AssetType = "drone" | "ground";
export type TaskStatus = "pending" | "assigned" | "in_progress" | "complete" | "failed";
export type ZoneType = "threat" | "no_go" | "gps_denied";

export interface Asset {
  id: string;
  type: AssetType;
  pos: Vec2;
  battery: number;        // 0–100
  payloadCapacity: number; // kg
  currentTask: string | null;
  route: Vec2[];
  routeIdx: number;
  status: "idle" | "en_route" | "critical";
}

export interface Task {
  id: string;
  pickup: Vec2;
  dropoff: Vec2;
  priority: number;       // 1–5
  payloadKg: number;
  deadlineTicks: number;
  status: TaskStatus;
  assignedAsset: string | null;
  createdTick: number;
}

export interface Zone {
  id: string;
  cells: Vec2[];
  type: ZoneType;
  riskScore: number;
}

export interface LogEntry {
  tick: number;
  msg: string;
}

export interface WorldState {
  gridSize: number;
  assets: Record<string, Asset>;
  tasks: Record<string, Task>;
  zones: Zone[];
  gpsDenied: Vec2[];
  tick: number;
  log: LogEntry[];
}

export interface PlannerWeights {
  travel: number;
  risk: number;
  battery: number;
  lateness: number;
  priority: number;
}

export interface AIPResponse {
  action: "update_constraints" | "override" | "explain";
  weights?: Partial<PlannerWeights>;
  taskId?: string;
  forceAssetType?: AssetType;
  forceAssetId?: string;
  explanation: string;
}
