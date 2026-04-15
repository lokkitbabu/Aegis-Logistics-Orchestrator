import { NextResponse } from "next/server";
import type { Hospital } from "@/lib/types";

export async function GET() {
  try {
    const url = "https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Hospital/FeatureServer/0/query?where=STATE%3D'GA'&outFields=OBJECTID,NAME,COUNTY,BEDS,LATITUDE,LONGITUDE,TYPE&outSR=4326&f=json&resultRecordCount=500";
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) throw new Error(`HIFLD API: ${res.status}`);
    const data = await res.json();
    // Build county name → FIPS lookup from feature attributes
    const hospitals: Hospital[] = (data.features ?? [])
      .filter((f: any) => f.attributes.LATITUDE && f.attributes.LONGITUDE)
      .map((f: any, i: number): Hospital => {
        const a = f.attributes;
        // Convert county name to approximate FIPS (GA state=13, need county portion)
        // We'll match by county name later when joining with census data
        return {
          id: `H${String(i+1).padStart(4,"0")}`,
          name: a.NAME ?? "Unknown Hospital",
          countyFips: "", // filled in during census join
          countyName: (a.COUNTY ?? "").toUpperCase(),
          beds: parseInt(a.BEDS) || 0,
          type: a.TYPE ?? "GENERAL ACUTE CARE",
          lat: parseFloat(a.LATITUDE),
          lng: parseFloat(a.LONGITUDE),
        };
      });
    return NextResponse.json({ hospitals, count: hospitals.length, fetchedAt: new Date().toISOString() });
  } catch(e) {
    return NextResponse.json({ hospitals: [], count: 0, error: String(e), fetchedAt: new Date().toISOString() });
  }
}
