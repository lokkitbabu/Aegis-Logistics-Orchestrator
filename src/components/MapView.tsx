"use client";
import { useEffect, useRef, useCallback } from "react";
import type { SystemState, CountyData, AlertLevel, ResponseResource, ResponseTask } from "@/lib/types";
import { ALERT_COLOR, RESOURCE_COLOR, TASK_COLOR, TASK_ICON } from "@/lib/types";

const RISK_FILL = (score: number): string => {
  if (score > 0.75) return "rgba(255,32,32,0.55)";
  if (score > 0.55) return "rgba(255,102,0,0.45)";
  if (score > 0.35) return "rgba(240,165,0,0.35)";
  if (score > 0.15) return "rgba(255,204,0,0.25)";
  return "rgba(0,80,120,0.12)";
};
const RISK_LINE = (score: number): string => {
  if (score > 0.75) return "#ff2020";
  if (score > 0.55) return "#ff6600";
  if (score > 0.35) return "#f0a500";
  if (score > 0.15) return "#ffcc00";
  return "rgba(0,200,255,0.2)";
};

interface Props {
  state: SystemState;
  onCountyClick: (fips: string) => void;
  selectedFips: string | null;
}

export default function MapView({ state, onCountyClick, selectedFips }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const initRef = useRef(false);
  const clickHandlerRef = useRef(onCountyClick);
  clickHandlerRef.current = onCountyClick;

  useEffect(() => {
    if (initRef.current || !containerRef.current) return;
    initRef.current = true;

    import("maplibre-gl").then(({ default: mgl }) => {
      const map = new mgl.Map({
        container: containerRef.current!,
        style: {
          version: 8,
          glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
          sources: {
            carto: { type:"raster", tiles:["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png","https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png"], tileSize:256 },
          },
          layers: [{ id:"carto", type:"raster", source:"carto" }],
        },
        center: [-83.5, 32.7], zoom: 6.5,
        attributionControl: false,
      });
      mapRef.current = map;
      (map as any)._mgl = mgl;

      map.on("load", () => {
        // County fill
        map.addSource("counties", { type:"geojson", data:{type:"FeatureCollection",features:[]} });
        map.addLayer({ id:"county-fill", type:"fill", source:"counties", paint:{ "fill-color":["get","fillColor"], "fill-opacity":1 } });
        map.addLayer({ id:"county-line", type:"line", source:"counties", paint:{ "line-color":["get","lineColor"], "line-width":["case",["get","selected"],2,0.6], "line-opacity":1 } });

        // Selected county highlight
        map.addLayer({ id:"county-selected", type:"line", source:"counties",
          filter:["==",["get","selected"],true],
          paint:{ "line-color":"#ffffff", "line-width":2.5, "line-opacity":0.9 } });

        // NWS alert polygons
        map.addSource("alert-polys", { type:"geojson", data:{type:"FeatureCollection",features:[]} });
        map.addLayer({ id:"alert-fill", type:"fill", source:"alert-polys", paint:{ "fill-color":["get","color"], "fill-opacity":0.18 } });
        map.addLayer({ id:"alert-line", type:"line", source:"alert-polys", paint:{ "line-color":["get","color"], "line-width":1.8, "line-opacity":0.8, "line-dasharray":[6,3] } });

        // County labels
        map.addLayer({ id:"county-labels", type:"symbol", source:"counties",
          layout:{ "text-field":["get","label"], "text-size":["interpolate",["linear"],["zoom"],6,8,9,11], "text-font":["Open Sans Regular"], "text-max-width":6 },
          paint:{ "text-color":["get","labelColor"], "text-opacity":0.9, "text-halo-color":"rgba(0,0,0,0.7)", "text-halo-width":1 } });

        // Click handler
        map.on("click","county-fill",(e:any) => {
          const fips = e.features?.[0]?.properties?.fips;
          if (fips) clickHandlerRef.current(fips);
        });
        map.on("mouseenter","county-fill",()=>{ map.getCanvas().style.cursor="pointer"; });
        map.on("mouseleave","county-fill",()=>{ map.getCanvas().style.cursor=""; });

        // Resource + task markers
        map.addSource("resources",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
        map.addLayer({id:"resource-dots",type:"circle",source:"resources",paint:{
          "circle-radius":7,"circle-color":["get","color"],"circle-opacity":0.85,
          "circle-stroke-color":"rgba(0,0,0,0.6)","circle-stroke-width":1.5,
        }});

        renderDynamicMarkers(map, mgl, state);
      });
    });

    return () => { mapRef.current?.remove(); mapRef.current=null; initRef.current=false; };
  }, []); // eslint-disable-line

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const mgl = (map as any)._mgl;

    try {
      // Update county GeoJSON with risk data
      if (state.countyGeoJSON) {
        const enriched = {
          ...state.countyGeoJSON,
          features: state.countyGeoJSON.features.map((f: any) => {
            const fips = f.properties?.GEOID ?? f.properties?.fips;
            const county = fips ? state.counties[fips] : null;
            const score = county?.riskScore ?? 0;
            const isSelected = fips === selectedFips;
            return {
              ...f,
              properties: {
                ...f.properties,
                fips,
                fillColor: RISK_FILL(score),
                lineColor: isSelected ? "#ffffff" : RISK_LINE(score),
                selected: isSelected,
                label: county ? `${county.name}\n${(score*100).toFixed(0)}` : "",
                labelColor: score > 0.55 ? "#ffffff" : score > 0.25 ? "#ffc080" : "rgba(255,255,255,0.4)",
              },
            };
          }),
        };
        (map.getSource("counties") as any)?.setData(enriched);
      }

      // NWS alert polygons
      const alertFeatures = state.alerts
        .filter(a => a.geometry)
        .map(a => ({
          type:"Feature" as const,
          properties: { color: ALERT_COLOR[a.level] ?? "#888", level: a.level },
          geometry: a.geometry,
        }));
      (map.getSource("alert-polys") as any)?.setData({type:"FeatureCollection",features:alertFeatures});

      // Resource dots
      const resourceFeats = Object.values(state.resources)
        .filter(r => r.lat && r.lng)
        .map(r => ({
          type:"Feature" as const,
          properties:{ id:r.id, color:RESOURCE_COLOR[r.type], status:r.status },
          geometry:{ type:"Point" as const, coordinates:[r.lng, r.lat] },
        }));
      (map.getSource("resources") as any)?.setData({type:"FeatureCollection",features:resourceFeats});

      if (mgl) renderDynamicMarkers(map, mgl, state);
    } catch {}
  }, [state, selectedFips]);

  return (
    <div style={{ position:"relative", width:"100%", height:"100%" }}>
      <div ref={containerRef} style={{ width:"100%", height:"100%" }} />
      {/* Risk legend */}
      <div style={{ position:"absolute", bottom:20, left:12, fontFamily:"'Share Tech Mono',monospace", fontSize:8, color:"rgba(255,255,255,0.6)", background:"rgba(6,9,13,0.85)", border:"1px solid rgba(255,120,0,0.15)", padding:"8px 10px", borderRadius:2 }}>
        <div style={{ color:"rgba(255,120,0,0.6)", letterSpacing:"0.15em", marginBottom:5, fontSize:8 }}>RISK SCORE</div>
        {[["#ff2020",">75%","Critical"],["#ff6600","55–75%","High"],["#f0a500","35–55%","Elevated"],["#ffcc00","15–35%","Moderate"],["rgba(0,150,200,0.6)","<15%","Low"]].map(([c,r,l])=>(
          <div key={l} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
            <div style={{ width:10, height:10, background:c, borderRadius:1 }}/>
            <span style={{ color:"rgba(255,255,255,0.5)" }}>{r}</span>
            <span style={{ color:"rgba(255,255,255,0.3)" }}>{l}</span>
          </div>
        ))}
        <div style={{ marginTop:5, color:"rgba(255,255,255,0.3)", fontSize:7 }}>Click county for details</div>
      </div>
    </div>
  );
}

function renderDynamicMarkers(map: any, mgl: any, state: SystemState) {
  if (!map._hospitalMarkers) map._hospitalMarkers = {};
  const existing = map._hospitalMarkers as Record<string, any>;

  // Hospital markers (red cross)
  const renderedFips = new Set<string>();
  for (const h of state.hospitals.slice(0, 80)) { // Cap for performance
    const key = h.id;
    if (!existing[key]) {
      const el = document.createElement("div");
      el.style.cssText = `width:12px;height:12px;background:rgba(255,32,32,0.85);border:1.5px solid #ff6060;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;cursor:default;box-shadow:0 0 6px rgba(255,32,32,0.5)`;
      el.textContent = "✚";
      existing[key] = new mgl.Marker({ element:el, anchor:"center" }).setLngLat([h.lng, h.lat]).addTo(map);
    }
    renderedFips.add(h.id);
  }
  // Remove stale
  for (const [key, marker] of Object.entries(existing)) {
    if (!renderedFips.has(key)) { (marker as any).remove(); delete existing[key]; }
  }
}
