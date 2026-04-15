export type Vec2 = [number, number];
export type AssetType = "drone" | "ground";
export type TaskStatus = "pending" | "approved" | "assigned" | "in_progress" | "complete" | "failed" | "cancelled";
export type ZoneType = "threat" | "no_go" | "gps_denied";
export type CargoType = "medevac" | "ammo" | "food" | "equipment" | "fuel";
export type NodeType = "fob" | "depot" | "outpost" | "lz";

export const CARGO_PRIORITY: Record<CargoType, number> = {
  medevac: 5, ammo: 4, fuel: 3, food: 2, equipment: 1,
};
export const CARGO_COLOR: Record<CargoType, string> = {
  medevac: "#ff3040", ammo: "#ff8c00", fuel: "#f0a500", food: "#00ff88", equipment: "#00e5ff",
};

export interface CargoManifest {
  type: CargoType;
  quantity: number;
  weightKg: number;
}

export interface SupplyNode {
  id: string;
  name: string;
  pos: Vec2;
  type: NodeType;
  inventory: Record<CargoType, number>;
  capacity:  Record<CargoType, number>;
  demandPerTick: Record<CargoType, number>;
  criticalThreshold: number; // 0-1, triggers auto-resupply
}

export interface Asset {
  id: string;
  type: AssetType;
  pos: Vec2;
  homeNodeId: string;
  battery: number;
  maxBattery: number;
  payloadCapacity: number;
  currentTask: string | null;
  route: Vec2[];
  routeIdx: number;
  status: "idle" | "en_route" | "returning" | "critical" | "recharging";
  cargo: CargoManifest[];
}

export interface Task {
  id: string;
  sourceNodeId: string;
  destNodeId: string;
  pickup: Vec2;
  dropoff: Vec2;
  priority: number;
  cargo: CargoManifest[];
  totalWeightKg: number;
  deadlineTicks: number;
  status: TaskStatus;
  assignedAsset: string | null;
  createdTick: number;
  approvedTick: number | null;
  completedTick: number | null;
  riskScore: number;
}

export interface Zone {
  id: string;
  cells: Vec2[];
  type: ZoneType;
  riskScore: number;
}

export interface WeatherState {
  windVec: Vec2;      // dx,dy in cells/tick effect
  windSpeed: number;  // 0-1
  visibility: number; // 0-1, affects GPS
}

export interface LogEntry { tick: number; msg: string; }

export interface WorldState {
  gridSize: number;
  assets: Record<string, Asset>;
  tasks: Record<string, Task>;
  nodes: Record<string, SupplyNode>;
  zones: Zone[];
  gpsDenied: Vec2[];
  weather: WeatherState;
  tick: number;
  log: LogEntry[];
  taskCounter: number;
}

export interface PlannerWeights {
  travel: number;
  risk: number;
  battery: number;
  lateness: number;
  priority: number;
  cargo: number;
}
export const DEFAULT_WEIGHTS: PlannerWeights = {
  travel: 1.0, risk: 2.5, battery: 1.5,
  lateness: 3.0, priority: 2.0, cargo: 1.5,
};

export interface AIPResponse {
  action: "update_constraints" | "override" | "explain" | "suggest_mission";
  weights?: Partial<PlannerWeights>;
  taskId?: string;
  forceAssetType?: AssetType;
  forceAssetId?: string;
  suggestedMission?: {
    sourceNodeId: string;
    destNodeId: string;
    cargoType: CargoType;
    quantity: number;
    priority: number;
  };
  explanation: string;
}
