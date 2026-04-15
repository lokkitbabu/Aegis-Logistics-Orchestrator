// ── Alert / Hazard ─────────────────────────────────────────────────────────────
export type AlertLevel = "none" | "advisory" | "watch" | "warning" | "emergency";
export type AlertSeverity = "Minor" | "Moderate" | "Severe" | "Extreme";

export const ALERT_ORDER: Record<AlertLevel, number> = { none:0, advisory:1, watch:2, warning:3, emergency:4 };
export const ALERT_COLOR: Record<AlertLevel, string> = {
  none:"#334455", advisory:"#0088ff", watch:"#ffcc00", warning:"#ff6600", emergency:"#ff2020",
};

export interface NWSAlert {
  id: string; event: string; headline: string;
  severity: AlertSeverity; certainty: string;
  issuedAt: string; expiresAt: string;
  level: AlertLevel;
  affectedZones: string[]; // NWS zone IDs like "GAZ001"
  affectedCountyFips: string[];
  geometry: any; // GeoJSON geometry if available
  description: string;
}

// ── FEMA ──────────────────────────────────────────────────────────────────────
export interface FEMADeclaration {
  disasterNumber: string;
  declarationType: string; // "Major Disaster", "Emergency"
  incidentType: string; // "Hurricane", "Flood", etc.
  declarationDate: string;
  countyFips: string;
  countyName: string;
  state: string;
  title: string;
}

// ── Facilities ────────────────────────────────────────────────────────────────
export interface Hospital {
  id: string; name: string;
  countyFips: string; countyName: string;
  beds: number; type: string;
  lat: number; lng: number;
}

// ── County ────────────────────────────────────────────────────────────────────
export interface CountyData {
  fips: string; // 5-digit
  name: string; state: string;
  // Census ACS
  population: number;
  elderlyCount: number;
  noVehicleHouseholds: number;
  povertyCount: number;
  // Derived
  elderlyPct: number; noVehiclePct: number; povertyPct: number;
  vulnerabilityScore: number; // 0–1
  // Live
  alertLevel: AlertLevel;
  alerts: NWSAlert[];
  hasDeclaration: boolean;
  declarations: FEMADeclaration[];
  hospitals: Hospital[];
  // Computed
  riskScore: number; // 0–1
  riskRank: number;
  impactedPopulation: number;
  // GeoJSON feature (injected client-side)
  geojsonFeature?: any;
}

// ── Resources ─────────────────────────────────────────────────────────────────
export type ResourceType = "assessment_crew" | "generator_team" | "supply_truck" | "shelter_team" | "medical_team";
export const RESOURCE_ICON: Record<ResourceType, string> = {
  assessment_crew:"👷", generator_team:"⚡", supply_truck:"🚛", shelter_team:"🏕", medical_team:"🏥",
};
export const RESOURCE_COLOR: Record<ResourceType, string> = {
  assessment_crew:"#00e5ff", generator_team:"#f0a500", supply_truck:"#88ff44",
  shelter_team:"#ff88cc", medical_team:"#ff3040",
};

export interface ResponseResource {
  id: string; type: ResourceType; label: string;
  baseFips: string; baseName: string;
  capacity: number; // units / teams
  status: "available" | "deployed" | "unavailable";
  assignedTaskId: string | null;
  assignedFips: string | null;
  lat: number; lng: number;
  notes?: string;
}

// ── Tasks ──────────────────────────────────────────────────────────────────────
export type TaskType = "damage_assessment" | "facility_check" | "shelter_support" | "resource_staging" | "evacuation_support";
export type TaskStatus = "pending" | "assigned" | "in_progress" | "complete" | "cancelled";

export const TASK_ICON: Record<TaskType, string> = {
  damage_assessment:"🔍", facility_check:"🏥", shelter_support:"🏕",
  resource_staging:"📦", evacuation_support:"🚨",
};
export const TASK_COLOR: Record<TaskType, string> = {
  damage_assessment:"#00e5ff", facility_check:"#ff3040", shelter_support:"#ff88cc",
  resource_staging:"#f0a500", evacuation_support:"#ff2020",
};

export interface ResponseTask {
  id: string; type: TaskType; title: string;
  targetFips: string; targetName: string;
  priorityScore: number; // 0–100
  status: TaskStatus;
  assignedResourceId: string | null;
  triggerReason: string;
  description: string;
  createdAt: string;
  deadlineHours: number;
  compatibleTypes: ResourceType[];
}

// ── Scoring ────────────────────────────────────────────────────────────────────
export interface ScoringWeights {
  weatherSeverity: number;
  femaDeclaration: number;
  populationExposure: number;
  vulnerability: number;
  criticalFacility: number;
}
export const DEFAULT_WEIGHTS: ScoringWeights = {
  weatherSeverity:0.35, femaDeclaration:0.20,
  populationExposure:0.15, vulnerability:0.20, criticalFacility:0.10,
};

// ── System State ──────────────────────────────────────────────────────────────
export interface DataFreshness {
  nws: string | null; fema: string | null; census: string | null; hospitals: string | null;
}

export interface LogEntry {
  id: string; timestamp: string;
  level: "info" | "warning" | "critical" | "action" | "aip";
  message: string;
}

export interface SystemState {
  counties: Record<string, CountyData>;
  alerts: NWSAlert[];
  declarations: FEMADeclaration[];
  hospitals: Hospital[];
  resources: Record<string, ResponseResource>;
  tasks: Record<string, ResponseTask>;
  countyGeoJSON: any | null; // Full GA county FeatureCollection
  freshness: DataFreshness;
  taskCounter: number;
  logCounter: number;
  log: LogEntry[];
  weights: ScoringWeights;
  isLoading: boolean;
  loadingStage: string;
  shortfallAnalysis: ShortfallAnalysis | null;
}

export interface ShortfallAnalysis {
  highPriorityTasks: number;
  coveredTasks: number;
  uncoveredTasks: number;
  uncoveredFips: string[];
  shortfallByType: Partial<Record<ResourceType, number>>;
  summary: string;
}

// ── AIP ───────────────────────────────────────────────────────────────────────
export interface AIPResponse {
  action: "situation_synthesis" | "recommend_actions" | "explain_decision" | "apply_override" | "resource_analysis";
  message: string;
  weightOverrides?: Partial<ScoringWeights>;
  forceHighPriorityFips?: string[];
}
