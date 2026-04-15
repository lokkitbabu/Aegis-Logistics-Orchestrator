import { NextResponse } from "next/server";

export async function GET() {
  try {
    // ACS 5-year estimates for Georgia counties
    // B01001_001E = total population
    // B01001_020E..025E = male 65+  (020=65-66, 021=67-69, 022=70-74, 023=75-79, 024=80-84, 025=85+)
    // B08201_002E = households with no vehicle
    // B17001_002E = below poverty level (for whom poverty determined)
    const vars = "NAME,B01001_001E,B01001_020E,B01001_021E,B01001_022E,B01001_044E,B01001_045E,B01001_046E,B08201_002E,B17001_002E";
    const url = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=county:*&in=state:13`;
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) throw new Error(`Census API: ${res.status}`);
    const rows: string[][] = await res.json();
    const header = rows[0];
    const idx = (n: string) => header.indexOf(n);

    const counties: Record<string, any> = {};
    for (const row of rows.slice(1)) {
      const stateFips = row[idx("state")];
      const countyFips = row[idx("county")];
      const fips = `${stateFips}${countyFips}`;
      const pop = parseInt(row[idx("B01001_001E")]) || 0;
      // Sum elderly (male + female 65+)
      const elderlyMale = ["B01001_020E","B01001_021E","B01001_022E"].reduce((s,v)=>s+(parseInt(row[idx(v)])||0),0);
      const elderlyFemale = ["B01001_044E","B01001_045E","B01001_046E"].reduce((s,v)=>s+(parseInt(row[idx(v)])||0),0);
      const elderly = elderlyMale + elderlyFemale;
      const noVehicle = parseInt(row[idx("B08201_002E")]) || 0;
      const poverty = parseInt(row[idx("B17001_002E")]) || 0;
      counties[fips] = {
        fips, name: row[idx("NAME")].split(",")[0].replace(" County",""), state:"GA",
        population: pop, elderlyCount: elderly, noVehicleHouseholds: noVehicle, povertyCount: poverty,
        elderlyPct: pop>0 ? (elderly/pop)*100 : 0,
        noVehiclePct: pop>0 ? (noVehicle/pop)*100 : 0,
        povertyPct: pop>0 ? (poverty/pop)*100 : 0,
      };
    }
    return NextResponse.json({ counties, count: Object.keys(counties).length, fetchedAt: new Date().toISOString() });
  } catch(e) {
    return NextResponse.json({ counties: {}, count: 0, error: String(e), fetchedAt: new Date().toISOString() });
  }
}
