"use client";
import { useEffect, useRef } from "react";
import type { SystemState, AlertLevel } from "@/lib/types";
import { ALERT_COLOR, RESOURCE_COLOR, TASK_COLOR, TASK_ICON } from "@/lib/types";

// ── Risk fill / line helpers ─────────────────────────────────────────────────
const RISK_FILL = (s: number) =>
  s > 0.75 ? "rgba(255,32,32,0.52)"  :
  s > 0.55 ? "rgba(255,102,0,0.42)"  :
  s > 0.35 ? "rgba(240,165,0,0.33)"  :
  s > 0.15 ? "rgba(255,204,0,0.22)"  : "rgba(0,80,120,0.1)";

const RISK_LINE = (s: number) =>
  s > 0.75 ? "#ff2020" : s > 0.55 ? "#ff6600" :
  s > 0.35 ? "#f0a500" : s > 0.15 ? "#ffcc00" : "rgba(0,200,255,0.18)";

// ── Centroid from GeoJSON geometry ───────────────────────────────────────────
function computeCentroid(geometry: any): [number, number] | null {
  if (!geometry) return null;
  let ring: number[][] = [];
  if (geometry.type === "Polygon") ring = geometry.coordinates[0];
  else if (geometry.type === "MultiPolygon") {
    let max = 0;
    for (const poly of geometry.coordinates)
      if (poly[0].length > max) { max = poly[0].length; ring = poly[0]; }
  }
  if (!ring.length) return null;
  const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
  const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  return [lng, lat];
}

// ── Alert pulse HTML ─────────────────────────────────────────────────────────
function makePulseEl(level: AlertLevel, riskScore: number): HTMLElement {
  const color = ALERT_COLOR[level] ?? "#f0a500";
  const size = level === "emergency" ? 48 : level === "warning" ? 38 : 28;
  const rings = level === "emergency" ? 3 : level === "warning" ? 2 : 1;
  const el = document.createElement("div");
  el.style.cssText = `position:relative;width:${size}px;height:${size}px;pointer-events:none`;
  const delays = ["0s","0.6s","1.2s"];
  let html = "";
  for (let i = 0; i < rings; i++) {
    html += `<div style="
      position:absolute;inset:0;border-radius:50%;
      border:${i===0?2:1}px solid ${color};
      opacity:${0.7 - i*0.2};
      animation:pulse-out ${1.8 + i*0.3}s ease-out ${delays[i]} infinite;
      transform-origin:center;
    "></div>`;
  }
  html += `<div style="
    position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
    width:8px;height:8px;border-radius:50%;
    background:${color};box-shadow:0 0 ${level==="emergency"?10:6}px ${color};
  "></div>`;
  el.innerHTML = html;
  return el;
}

// ── Task marker HTML ─────────────────────────────────────────────────────────
function makeTaskEl(taskType: string, status: string, priority: number): HTMLElement {
  const color = TASK_COLOR[taskType as keyof typeof TASK_COLOR] ?? "#f0a500";
  const icon  = TASK_ICON[taskType  as keyof typeof TASK_ICON]  ?? "📋";
  const statusColor = status === "assigned" || status === "in_progress" ? "#00ff88"
                    : status === "pending"  ? "#f0a500" : "#888";
  const scale = priority >= 80 ? 1.15 : priority >= 60 ? 1.0 : 0.85;
  const el = document.createElement("div");
  el.style.cssText = `
    position:relative;cursor:pointer;
    transform:scale(${scale});transform-origin:center bottom;
    font-family:'Share Tech Mono',monospace;
  `;
  el.innerHTML = `
    <div style="
      display:flex;align-items:center;justify-content:center;
      width:32px;height:32px;
      background:rgba(6,9,16,0.92);
      border:1.5px solid ${color};
      clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);
      box-shadow:0 0 12px ${color}55;
      font-size:14px;
    ">${icon}</div>
    <div style="
      position:absolute;top:-7px;right:-5px;
      width:14px;height:14px;border-radius:50%;
      background:${statusColor};border:1.5px solid rgba(0,0,0,0.7);
      box-shadow:0 0 5px ${statusColor};
    "></div>
    <div style="
      position:absolute;bottom:-15px;left:50%;transform:translateX(-50%);
      font-size:7px;color:${color};white-space:nowrap;letter-spacing:0.06em;
      text-shadow:0 1px 4px rgba(0,0,0,0.9);
    ">P${priority}</div>
  `;
  return el;
}

// ── Resource marker HTML ─────────────────────────────────────────────────────
function makeResourceEl(type: string, status: string): HTMLElement {
  const color = RESOURCE_COLOR[type as keyof typeof RESOURCE_COLOR] ?? "#00e5ff";
  const el = document.createElement("div");
  el.style.cssText = `font-family:'Share Tech Mono',monospace;pointer-events:none`;
  el.innerHTML = `
    <div style="
      width:22px;height:22px;border-radius:50%;
      background:rgba(6,9,16,0.9);
      border:${status==="deployed"?"2":"1.5"}px solid ${color};
      display:flex;align-items:center;justify-content:center;
      font-size:10px;
      box-shadow:0 0 ${status==="deployed"?10:5}px ${color}${status==="deployed"?"88":"44"};
      ${status==="deployed"?"animation:resource-pulse 2s ease-in-out infinite":""}
    ">●</div>
  `;
  return el;
}

interface Props {
  state: SystemState;
  prevState: SystemState | null;
  onCountyClick: (fips: string) => void;
  selectedFips: string | null;
}

export default function MapView({ state, prevState, onCountyClick, selectedFips }: Props) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const mapRef         = useRef<any>(null);
  const initRef        = useRef(false);
  const centroidsRef   = useRef<Map<string, [number,number]>>(new Map());
  const clickHandlerRef = useRef(onCountyClick);
  const flashTimers    = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  clickHandlerRef.current = onCountyClick;

  // ── Map init ─────────────────────────────────────────────────────────────
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
            carto: { type:"raster",
              tiles:["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
                     "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png"],
              tileSize:256 },
          },
          layers:[{ id:"carto", type:"raster", source:"carto" }],
        },
        center: [-83.5, 32.7], zoom: 6.5,
        attributionControl: false,
      });
      mapRef.current = map;
      (map as any)._mgl = mgl;

      map.on("load", () => {
        // ── County choropleth ────────────────────────────────────────────
        map.addSource("counties", { type:"geojson", data:{type:"FeatureCollection",features:[]} });
        map.addLayer({ id:"county-fill", type:"fill", source:"counties",
          paint:{ "fill-color":["get","fillColor"], "fill-opacity":1 } });
        map.addLayer({ id:"county-line", type:"line", source:"counties",
          paint:{ "line-color":["get","lineColor"],
                  "line-width":["case",["get","selected"],2.5,["get","alerted"],1.2,0.5] } });
        map.addLayer({ id:"county-selected", type:"line", source:"counties",
          filter:["==",["get","selected"],true],
          paint:{ "line-color":"#ffffff","line-width":2.5,"line-opacity":0.85 } });

        // ── Flash layer for changed counties ─────────────────────────────
        map.addSource("flash", { type:"geojson", data:{type:"FeatureCollection",features:[]} });
        map.addLayer({ id:"county-flash", type:"fill", source:"flash",
          paint:{ "fill-color":"#ffffff","fill-opacity":["get","opacity"] } });

        // ── NWS alert polygons ────────────────────────────────────────────
        map.addSource("alert-polys", { type:"geojson", data:{type:"FeatureCollection",features:[]} });
        map.addLayer({ id:"alert-fill", type:"fill", source:"alert-polys",
          paint:{ "fill-color":["get","color"],"fill-opacity":0.15 } });
        map.addLayer({ id:"alert-line", type:"line", source:"alert-polys",
          paint:{ "line-color":["get","color"],"line-width":2,"line-opacity":0.7,
                  "line-dasharray":[6,3] } });

        // ── Resource deployment lines ─────────────────────────────────────
        map.addSource("deploy-lines", { type:"geojson", data:{type:"FeatureCollection",features:[]} });
        map.addLayer({ id:"deploy-lines-bg", type:"line", source:"deploy-lines",
          paint:{ "line-color":["get","color"],"line-width":3,"line-opacity":0.12,"line-blur":4 } });
        map.addLayer({ id:"deploy-lines-fg", type:"line", source:"deploy-lines",
          paint:{ "line-color":["get","color"],"line-width":1.2,"line-opacity":0.6,
                  "line-dasharray":[4,3] } });

        // ── County labels ─────────────────────────────────────────────────
        map.addLayer({ id:"county-labels", type:"symbol", source:"counties",
          layout:{ "text-field":["get","label"],
                   "text-size":["interpolate",["linear"],["zoom"],6,8,9,11],
                   "text-font":["Open Sans Regular"],"text-max-width":6 },
          paint:{ "text-color":["get","labelColor"],"text-opacity":0.85,
                  "text-halo-color":"rgba(0,0,0,0.75)","text-halo-width":1.2 } });

        // ── Hospital markers ──────────────────────────────────────────────
        map.addSource("hospitals-src", { type:"geojson", data:{type:"FeatureCollection",features:[]} });
        map.addLayer({ id:"hospital-halo", type:"circle", source:"hospitals-src",
          paint:{ "circle-radius":6,"circle-color":"transparent",
                  "circle-stroke-color":"rgba(255,80,80,0.8)","circle-stroke-width":1.5 } });
        map.addLayer({ id:"hospital-dot", type:"circle", source:"hospitals-src",
          paint:{ "circle-radius":3.5,"circle-color":"rgba(255,80,80,0.9)" } });

        // ── Click handler ─────────────────────────────────────────────────
        map.on("click","county-fill",(e:any)=>{
          const fips=e.features?.[0]?.properties?.fips;
          if(fips) clickHandlerRef.current(fips);
        });
        map.on("mouseenter","county-fill",()=>{ map.getCanvas().style.cursor="pointer"; });
        map.on("mouseleave","county-fill",()=>{ map.getCanvas().style.cursor=""; });

        // Task, alert pulse, resource markers will be rendered as HTML markers
        (map as any)._taskMarkers = {};
        (map as any)._pulseMakers = {};
        (map as any)._resourceMarkers = {};
      });
    });

    return () => {
      flashTimers.current.forEach(t => clearTimeout(t));
      mapRef.current?.remove();
      mapRef.current = null;
      initRef.current = false;
    };
  }, []); // eslint-disable-line

  // ── Update all map state ─────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const mgl = (map as any)._mgl;

    // Build centroid cache from GeoJSON
    if (state.countyGeoJSON && centroidsRef.current.size < 10) {
      for (const f of state.countyGeoJSON.features) {
        const fips = f.properties?.GEOID ?? f.properties?.fips;
        const c = computeCentroid(f.geometry);
        if (fips && c) centroidsRef.current.set(fips, c);
      }
    }

    // ── Detect risk score changes (for flash) ────────────────────────────
    const flashFips = new Set<string>();
    if (prevState) {
      for (const [fips, county] of Object.entries(state.counties)) {
        const prev = prevState.counties[fips];
        if (prev && county.riskScore - prev.riskScore > 0.08) flashFips.add(fips);
      }
    }

    try {
      // ── County choropleth ──────────────────────────────────────────────
      if (state.countyGeoJSON) {
        const enriched = {
          ...state.countyGeoJSON,
          features: state.countyGeoJSON.features.map((f: any) => {
            const fips = f.properties?.GEOID ?? f.properties?.fips;
            const county = fips ? state.counties[fips] : null;
            const score = county?.riskScore ?? 0;
            const isSelected = fips === selectedFips;
            const isAlerted = county?.alertLevel !== "none" && county?.alertLevel !== undefined;
            return {
              ...f,
              properties: {
                ...f.properties,
                fips,
                fillColor:  RISK_FILL(score),
                lineColor:  isSelected ? "#ffffff" : isAlerted ? ALERT_COLOR[county!.alertLevel] : RISK_LINE(score),
                alerted:    isAlerted,
                selected:   isSelected,
                label:      county ? `${county.name}\n${(score*100).toFixed(0)}` : "",
                labelColor: score > 0.55 ? "#ffffff" : score > 0.25 ? "#ffc080" : "rgba(255,255,255,0.35)",
              },
            };
          }),
        };
        (map.getSource("counties") as any)?.setData(enriched);
      }

      // ── Flash overlay for changed counties ─────────────────────────────
      if (flashFips.size > 0 && state.countyGeoJSON) {
        const flashFeatures = state.countyGeoJSON.features
          .filter((f: any) => flashFips.has(f.properties?.GEOID ?? f.properties?.fips))
          .map((f: any) => ({ ...f, properties: { ...f.properties, opacity: 0.3 } }));
        (map.getSource("flash") as any)?.setData({ type:"FeatureCollection", features: flashFeatures });

        // Fade out after 800ms
        const timer = setTimeout(() => {
          (map.getSource("flash") as any)?.setData({ type:"FeatureCollection", features: [] });
        }, 900);
        flashTimers.current.set("flash", timer);
      }

      // ── NWS alert polygons ─────────────────────────────────────────────
      const alertFeats = state.alerts.filter(a => a.geometry).map(a => ({
        type:"Feature" as const, properties:{ color: ALERT_COLOR[a.level] ?? "#f0a500" },
        geometry: a.geometry,
      }));
      (map.getSource("alert-polys") as any)?.setData({ type:"FeatureCollection", features: alertFeats });

      // ── Hospital dots ──────────────────────────────────────────────────
      const hospFeats = state.hospitals.slice(0,100).filter(h => h.lat && h.lng).map(h => ({
        type:"Feature" as const, properties: {},
        geometry:{ type:"Point" as const, coordinates:[h.lng, h.lat] },
      }));
      (map.getSource("hospitals-src") as any)?.setData({ type:"FeatureCollection", features: hospFeats });

      // ── Resource deployment lines ──────────────────────────────────────
      const deployLines: any[] = [];
      for (const r of Object.values(state.resources)) {
        if (r.status !== "deployed" || !r.assignedFips) continue;
        const targetCentroid = centroidsRef.current.get(r.assignedFips);
        if (!targetCentroid || !r.lat || !r.lng) continue;
        const color = RESOURCE_COLOR[r.type] ?? "#00e5ff";
        deployLines.push({
          type:"Feature" as const,
          properties:{ color },
          geometry:{ type:"LineString" as const, coordinates:[[r.lng, r.lat], targetCentroid] },
        });
      }
      (map.getSource("deploy-lines") as any)?.setData({ type:"FeatureCollection", features: deployLines });

      // ── HTML markers ──────────────────────────────────────────────────
      if (mgl) {
        renderAlertPulseMarkers(map, mgl, state, centroidsRef.current);
        renderTaskMarkers(map, mgl, state, centroidsRef.current);
        renderResourceMarkers(map, mgl, state);
      }
    } catch {}
  }, [state, prevState, selectedFips]);

  return (
    <div style={{ position:"relative", width:"100%", height:"100%" }}>
      <div ref={containerRef} style={{ width:"100%", height:"100%" }}/>
      {/* CSS keyframes for animations */}
      <style>{`
        @keyframes pulse-out {
          0%   { transform:scale(1);   opacity:0.8; }
          100% { transform:scale(3.5); opacity:0;   }
        }
        @keyframes resource-pulse {
          0%,100% { box-shadow:0 0 6px currentColor; }
          50%     { box-shadow:0 0 14px currentColor; }
        }
      `}</style>
      {/* Risk legend */}
      <div style={{ position:"absolute",bottom:20,left:12,fontFamily:"'Share Tech Mono',monospace",fontSize:8,color:"rgba(255,255,255,0.6)",background:"rgba(6,9,13,0.88)",border:"1px solid rgba(255,120,0,0.15)",padding:"8px 10px",borderRadius:2,zIndex:10 }}>
        <div style={{ color:"rgba(255,120,0,0.55)",letterSpacing:"0.15em",marginBottom:5,fontSize:8 }}>RISK SCORE</div>
        {[["#ff2020",">75","Critical"],["#ff6600","55–75","High"],["#f0a500","35–55","Elevated"],["#ffcc00","15–35","Moderate"],["rgba(0,150,200,0.6)","<15","Low"]].map(([c,r,l])=>(
          <div key={l} style={{ display:"flex",alignItems:"center",gap:6,marginBottom:2 }}>
            <div style={{ width:10,height:10,background:c,borderRadius:1,flexShrink:0 }}/>
            <span style={{ color:"rgba(255,255,255,0.45)" }}>{r}%</span>
            <span style={{ color:"rgba(255,255,255,0.25)" }}>{l}</span>
          </div>
        ))}
        <div style={{ marginTop:6,paddingTop:5,borderTop:"1px solid rgba(255,120,0,0.1)",display:"flex",flexDirection:"column",gap:3 }}>
          <div style={{ display:"flex",alignItems:"center",gap:5 }}><div style={{ width:8,height:8,borderRadius:"50%",background:"rgba(0,229,255,0.7)",flexShrink:0 }}/><span style={{ color:"rgba(255,255,255,0.25)" }}>Alert pulse</span></div>
          <div style={{ display:"flex",alignItems:"center",gap:5 }}><div style={{ width:8,height:8,background:"rgba(255,80,80,0.85)",borderRadius:1,flexShrink:0 }}/><span style={{ color:"rgba(255,255,255,0.25)" }}>Hospital</span></div>
          <div style={{ display:"flex",alignItems:"center",gap:5 }}><div style={{ width:12,height:1.5,background:"rgba(0,200,80,0.7)",flexShrink:0 }}/><span style={{ color:"rgba(255,255,255,0.25)" }}>Deployment</span></div>
        </div>
        <div style={{ marginTop:5,fontSize:7,color:"rgba(255,255,255,0.2)" }}>Click county for details</div>
      </div>
    </div>
  );
}

// ── Alert pulse markers ───────────────────────────────────────────────────────
function renderAlertPulseMarkers(
  map: any, mgl: any, state: SystemState,
  centroids: Map<string, [number,number]>
) {
  if (!map._pulseMarkers) map._pulseMarkers = {} as Record<string,any>;
  const markers = map._pulseMarkers as Record<string,any>;
  const activeKeys = new Set<string>();

  for (const county of Object.values(state.counties)) {
    if (county.alertLevel === "none" || !county.alerts.length) continue;
    const centroid = centroids.get(county.fips);
    if (!centroid) continue;
    activeKeys.add(county.fips);

    if (markers[county.fips]) {
      // Update position only
      markers[county.fips].setLngLat(centroid);
    } else {
      const el = makePulseEl(county.alertLevel, county.riskScore);
      markers[county.fips] = new mgl.Marker({ element: el, anchor:"center" })
        .setLngLat(centroid)
        .addTo(map);
    }
  }

  // Remove stale
  for (const [key, marker] of Object.entries(markers)) {
    if (!activeKeys.has(key)) { (marker as any).remove(); delete markers[key]; }
  }
}

// ── Task markers ──────────────────────────────────────────────────────────────
function renderTaskMarkers(
  map: any, mgl: any, state: SystemState,
  centroids: Map<string, [number,number]>
) {
  if (!map._taskMarkers) map._taskMarkers = {} as Record<string,any>;
  const markers = map._taskMarkers as Record<string,any>;
  const activeKeys = new Set<string>();

  const activeTasks = Object.values(state.tasks)
    .filter(t => !["complete","cancelled","rejected"].includes(t.status));

  for (const task of activeTasks) {
    const centroid = centroids.get(task.targetFips);
    if (!centroid) continue;

    // Slight offset so multiple tasks on same county don't stack exactly
    const taskIndex = activeTasks.filter(t2 => t2.targetFips === task.targetFips).indexOf(task);
    const offsetLng = centroid[0] + (taskIndex - 1) * 0.04;
    const offsetLat = centroid[1] + (taskIndex % 2) * 0.03;

    activeKeys.add(task.id);

    if (markers[task.id]) {
      markers[task.id].setLngLat([offsetLng, offsetLat]);
      // Rebuild el to update status/priority
      const newEl = makeTaskEl(task.type, task.status, task.priorityScore);
      const existing = markers[task.id].getElement();
      existing.innerHTML = newEl.innerHTML;
    } else {
      const el = makeTaskEl(task.type, task.status, task.priorityScore);
      el.addEventListener("click", () => {
        // Don't propagate to map click
        void el;
      });
      markers[task.id] = new mgl.Marker({ element: el, anchor:"bottom" })
        .setLngLat([offsetLng, offsetLat])
        .addTo(map);
    }
  }

  for (const [key, marker] of Object.entries(markers)) {
    if (!activeKeys.has(key)) { (marker as any).remove(); delete markers[key]; }
  }
}

// ── Resource markers ──────────────────────────────────────────────────────────
function renderResourceMarkers(map: any, mgl: any, state: SystemState) {
  if (!map._resourceMarkers) map._resourceMarkers = {} as Record<string,any>;
  const markers = map._resourceMarkers as Record<string,any>;

  for (const r of Object.values(state.resources)) {
    if (!r.lat || !r.lng) continue;

    if (markers[r.id]) {
      markers[r.id].setLngLat([r.lng, r.lat]);
      const el = markers[r.id].getElement();
      const dot = el.querySelector("div");
      if (dot) {
        const color = RESOURCE_COLOR[r.type] ?? "#00e5ff";
        dot.style.borderWidth = r.status === "deployed" ? "2px" : "1.5px";
        dot.style.boxShadow = `0 0 ${r.status==="deployed"?10:5}px ${color}${r.status==="deployed"?"88":"44"}`;
      }
    } else {
      const el = makeResourceEl(r.type, r.status);
      markers[r.id] = new mgl.Marker({ element: el, anchor:"center" })
        .setLngLat([r.lng, r.lat])
        .addTo(map);
    }
  }
}
