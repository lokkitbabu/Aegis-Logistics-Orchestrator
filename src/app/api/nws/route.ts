import { NextResponse } from "next/server";
import type { NWSAlert, AlertLevel } from "@/lib/types";

function severityToLevel(severity: string, event: string): AlertLevel {
  const e = event.toLowerCase();
  if (severity==="Extreme"||e.includes("tornado warning")||e.includes("flash flood emergency")) return "emergency";
  if (severity==="Severe"||e.includes("warning")) return "warning";
  if (severity==="Moderate"||e.includes("watch")) return "watch";
  if (e.includes("advisory")||e.includes("statement")) return "advisory";
  return "advisory";
}

// Map NWS zone IDs to county FIPS for Georgia (abbreviated - real system would use full zone→FIPS table)
function zonesToFips(zones: string[]): string[] {
  // NWS zones for GA counties: GAC001 = Appling (13001), etc.
  // Zone format: GAZ001 or GAC001 (county zone)
  const fips: string[] = [];
  for (const z of zones) {
    const match = z.match(/GAC(\d{3})/i);
    if (match) {
      const num = parseInt(match[1]);
      // Convert zone number to FIPS county code (Georgia county FIPS are odd: 001,003,005...)
      const fipsNum = num * 2 - 1;
      fips.push(`13${String(fipsNum).padStart(3,"0")}`);
    }
    // Also try GAZ (forecast zone) - map common ones
    const zoneMatch = z.match(/GAZ(\d{3})/i);
    if (zoneMatch) {
      // Approximate zone→county mapping for common GA zones
      const zoneNum = parseInt(zoneMatch[1]);
      if (zoneNum >= 1 && zoneNum <= 159) {
        const fipsNum = zoneNum * 2 - 1;
        fips.push(`13${String(Math.min(fipsNum,321)).padStart(3,"0")}`);
      }
    }
  }
  return [...new Set(fips)];
}

export async function GET() {
  try {
    const res = await fetch("https://api.weather.gov/alerts/active?area=GA", {
      headers: { "User-Agent": "AEGISEmergencyOps/1.0 (emergency.demo@example.com)", "Accept": "application/geo+json" },
      next: { revalidate: 120 },
    });
    if (!res.ok) throw new Error(`NWS API: ${res.status}`);
    const data = await res.json();
    const alerts: NWSAlert[] = (data.features ?? []).map((f: any): NWSAlert => {
      const p = f.properties;
      const affectedZones: string[] = (p.geocode?.UGC ?? []);
      return {
        id: p.id ?? f.id,
        event: p.event ?? "Unknown",
        headline: p.headline ?? p.event ?? "",
        severity: p.severity ?? "Unknown",
        certainty: p.certainty ?? "Unknown",
        issuedAt: p.sent ?? p.effective ?? "",
        expiresAt: p.expires ?? p.ends ?? "",
        level: severityToLevel(p.severity, p.event ?? ""),
        affectedZones,
        affectedCountyFips: zonesToFips(affectedZones),
        geometry: f.geometry,
        description: (p.description ?? "").substring(0, 500),
      };
    });
    return NextResponse.json({ alerts, count: alerts.length, fetchedAt: new Date().toISOString() });
  } catch(e) {
    return NextResponse.json({ alerts: [], count: 0, error: String(e), fetchedAt: new Date().toISOString() });
  }
}
