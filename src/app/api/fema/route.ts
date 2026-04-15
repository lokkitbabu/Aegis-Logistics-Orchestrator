import { NextResponse } from "next/server";
import type { FEMADeclaration } from "@/lib/types";

export async function GET() {
  try {
    // Get recent GA disaster declarations (last 5 years)
    const since = new Date(); since.setFullYear(since.getFullYear()-5);
    const url = `https://www.fema.gov/api/open/v2/disasterDeclarations?state=GA&declarationDate=${since.toISOString()}&$format=json&$top=200&$orderby=declarationDate desc`;
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) throw new Error(`FEMA API: ${res.status}`);
    const data = await res.json();
    const declarations: FEMADeclaration[] = (data.DisasterDeclarationsSummaries ?? []).map((d: any): FEMADeclaration => ({
      disasterNumber: d.disasterNumber,
      declarationType: d.declarationType,
      incidentType: d.incidentType,
      declarationDate: d.declarationDate,
      countyFips: d.fipsStateCode && d.fipsCountyCode ? `${d.fipsStateCode}${d.fipsCountyCode}` : "",
      countyName: d.designatedArea ?? "",
      state: d.state,
      title: d.declarationTitle ?? d.incidentType,
    })).filter((d: FEMADeclaration) => d.countyFips.length===5);
    return NextResponse.json({ declarations, count: declarations.length, fetchedAt: new Date().toISOString() });
  } catch(e) {
    return NextResponse.json({ declarations: [], count: 0, error: String(e), fetchedAt: new Date().toISOString() });
  }
}
