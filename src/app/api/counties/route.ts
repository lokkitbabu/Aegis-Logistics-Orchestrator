import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Census TIGER simplified county boundaries for Georgia
    const url = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query?where=STATEFP%3D'13'&outFields=GEOID,NAME,STATEFP,COUNTYFP&f=geojson&outSR=4326&resultRecordCount=200";
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) throw new Error(`TIGER API: ${res.status}`);
    const geojson = await res.json();
    return NextResponse.json(geojson);
  } catch(e) {
    // Fallback: return null so client uses simplified rendering
    return NextResponse.json({ type:"FeatureCollection", features:[], error: String(e) });
  }
}
