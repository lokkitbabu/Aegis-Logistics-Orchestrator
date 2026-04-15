/**
 * Simulation engine — injects realistic events to demonstrate the system
 * when live NWS alerts are quiet (common outside hurricane/tornado season).
 *
 * Scenarios are modeled after real Georgia disaster types:
 *   Coastal flooding (Chatham, Bryan, Glynn, Camden)
 *   Tornado outbreak (Fulton, Coweta, Troup, Harris)
 *   Inland flooding (Lowndes, Thomas, Brooks)
 *   Ice storm (North GA: Cherokee, Pickens, Gilmer)
 */
import type { NWSAlert, AlertLevel } from "./types";

export interface SimScenario {
  id: string;
  name: string;
  description: string;
  affectedCounties: Array<{ fips: string; name: string; alertLevel: AlertLevel }>;
  alertType: string;
  phases: SimPhase[];
}

export interface SimPhase {
  label: string;
  delayMs: number;
  alerts: Partial<NWSAlert>[];
}

const now = () => new Date().toISOString();
const expires = (hours: number) => new Date(Date.now() + hours * 3600000).toISOString();

export const SIM_SCENARIOS: SimScenario[] = [
  {
    id: "coastal_flood",
    name: "Coastal Flooding — Southeast Georgia",
    description: "Tropical system brings storm surge and inland flooding to coastal counties",
    affectedCounties: [
      { fips: "13051", name: "Chatham", alertLevel: "emergency" },
      { fips: "13029", name: "Bryan", alertLevel: "warning" },
      { fips: "13127", name: "Glynn", alertLevel: "warning" },
      { fips: "13039", name: "Camden", alertLevel: "watch" },
      { fips: "13191", name: "McIntosh", alertLevel: "warning" },
      { fips: "13179", name: "Liberty", alertLevel: "watch" },
    ],
    alertType: "Storm Surge Warning",
    phases: [
      { label: "Watch issued", delayMs: 0, alerts: [] },
      { label: "Warning escalated", delayMs: 8000, alerts: [] },
      { label: "Emergency declared", delayMs: 16000, alerts: [] },
    ],
  },
  {
    id: "tornado_metro",
    name: "Tornado Outbreak — Metro Atlanta",
    description: "Severe tornado watch with confirmed touchdowns across north Georgia",
    affectedCounties: [
      { fips: "13121", name: "Fulton", alertLevel: "warning" },
      { fips: "13089", name: "DeKalb", alertLevel: "warning" },
      { fips: "13063", name: "Clayton", alertLevel: "emergency" },
      { fips: "13067", name: "Cobb", alertLevel: "watch" },
      { fips: "13135", name: "Gwinnett", alertLevel: "watch" },
      { fips: "13077", name: "Coweta", alertLevel: "advisory" },
    ],
    alertType: "Tornado Warning",
    phases: [
      { label: "Watch issued", delayMs: 0, alerts: [] },
      { label: "Tornado confirmed", delayMs: 6000, alerts: [] },
      { label: "Emergency — direct hit", delayMs: 12000, alerts: [] },
    ],
  },
  {
    id: "inland_flood",
    name: "Flash Flooding — South Georgia",
    description: "Slow-moving storm system saturates already-wet South Georgia counties",
    affectedCounties: [
      { fips: "13185", name: "Lowndes", alertLevel: "warning" },
      { fips: "13275", name: "Thomas", alertLevel: "watch" },
      { fips: "13027", name: "Brooks", alertLevel: "watch" },
      { fips: "13173", name: "Lanier", alertLevel: "advisory" },
      { fips: "13299", name: "Ware", alertLevel: "advisory" },
    ],
    alertType: "Flash Flood Warning",
    phases: [
      { label: "Advisory issued", delayMs: 0, alerts: [] },
      { label: "Flash Flood Warning", delayMs: 10000, alerts: [] },
    ],
  },
  {
    id: "ice_storm",
    name: "Ice Storm — North Georgia Mountains",
    description: "Freezing rain and ice accumulation across mountain counties",
    affectedCounties: [
      { fips: "13057", name: "Cherokee", alertLevel: "warning" },
      { fips: "13221", name: "Pickens", alertLevel: "warning" },
      { fips: "13111", name: "Gilmer", alertLevel: "watch" },
      { fips: "13187", name: "Lumpkin", alertLevel: "advisory" },
      { fips: "13311", name: "White", alertLevel: "advisory" },
    ],
    alertType: "Winter Storm Warning",
    phases: [
      { label: "Advisory issued", delayMs: 0, alerts: [] },
      { label: "Warning upgraded", delayMs: 9000, alerts: [] },
    ],
  },
];

/**
 * Build NWSAlert objects for a scenario's affected counties.
 */
export function buildScenarioAlerts(scenario: SimScenario): NWSAlert[] {
  return scenario.affectedCounties.map((county, i) => ({
    id: `SIM-${scenario.id}-${county.fips}`,
    event: scenario.alertType,
    headline: `${scenario.alertType} issued for ${county.name} County`,
    severity: county.alertLevel === "emergency" ? "Extreme" :
              county.alertLevel === "warning"   ? "Severe"  :
              county.alertLevel === "watch"     ? "Moderate" : "Minor",
    certainty: county.alertLevel === "emergency" ? "Observed" : "Likely",
    issuedAt: now(),
    expiresAt: expires(12),
    level: county.alertLevel,
    affectedZones: [],
    affectedCountyFips: [county.fips],
    geometry: null,
    description: `${scenario.description}. ${scenario.alertType} in effect until further notice.`,
  }));
}
