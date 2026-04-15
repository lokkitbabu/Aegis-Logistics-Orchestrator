"use client";
import { useEffect, useRef } from "react";
import type { WorldState, Vec2, SupplyNode, CargoType } from "@/lib/types";
import { CARGO_COLOR } from "@/lib/types";

const GRID = 20;
const SW: [number,number] = [-116.18, 37.08];
const NE: [number,number] = [-115.55, 37.58];

export function g2ll(x: number, y: number): [number,number] {
  return [SW[0]+(x/(GRID-1))*(NE[0]-SW[0]), SW[1]+(y/(GRID-1))*(NE[1]-SW[1])];
}

function cellPoly(cx: number, cy: number): number[][] {
  const dw=(NE[0]-SW[0])/GRID, dh=(NE[1]-SW[1])/GRID;
  const [lng,lat]=g2ll(cx,cy);
  return [[lng-dw/2,lat-dh/2],[lng+dw/2,lat-dh/2],[lng+dw/2,lat+dh/2],[lng-dw/2,lat+dh/2],[lng-dw/2,lat-dh/2]];
}

const ASSET_COLORS: Record<string,string> = { D1:"#00e5ff", D2:"#ff44aa", G1:"#00ff88" };

const NODE_STYLES: Record<string, { color:string; shape:string; size:number }> = {
  fob:     { color:"#00e5ff",  shape:"hexagon", size:22 },
  depot:   { color:"#f0a500",  shape:"square",  size:18 },
  outpost: { color:"#ff6644",  shape:"diamond", size:16 },
  lz:      { color:"#88ff44",  shape:"circle",  size:14 },
};

function hexPath(cx: number, cy: number, r: number): string {
  return Array.from({length:6},(_,i)=>{
    const a = (i*60-30)*Math.PI/180;
    return `${cx+r*Math.cos(a)},${cy+r*Math.sin(a)}`;
  }).join(" ");
}

interface Props { state: WorldState; showRanges: boolean; }

export default function MapView({ state, showRanges }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current || !containerRef.current) return;
    initRef.current = true;

    import("maplibre-gl").then(({ default: mgl }) => {
      const center: [number,number] = [(SW[0]+NE[0])/2, (SW[1]+NE[1])/2];
      const map = new mgl.Map({
        container: containerRef.current!,
        style: {
          version: 8,
          glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
          sources: {
            esri: {
              type: "raster",
              tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
              tileSize: 256,
              maxzoom: 18,
              attribution: "© Esri",
            },
            labels: {
              type: "raster",
              tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
              tileSize: 256,
            },
          },
          layers: [
            { id:"satellite", type:"raster", source:"esri" },
            { id:"labels",    type:"raster", source:"labels", paint:{"raster-opacity":0.4} },
            // Dark tactical overlay
            {
              id: "dark-overlay",
              type: "background",
              paint: { "background-color": "rgba(4,10,16,0.45)" },
            },
          ],
        },
        center, zoom: 9.0, bearing: 0, pitch: 0, attributionControl: false,
      });
      mapRef.current = map;
      (map as any)._mgl = mgl;

      map.on("load", () => {
        // AOR boundary
        map.addSource("aor", { type:"geojson", data: {
          type:"Feature" as const, properties:{},
          geometry:{ type:"Polygon" as const, coordinates:[[
            [SW[0]-0.01,SW[1]-0.01],[NE[0]+0.01,SW[1]-0.01],
            [NE[0]+0.01,NE[1]+0.01],[SW[0]-0.01,NE[1]+0.01],[SW[0]-0.01,SW[1]-0.01],
          ]]},
        }});
        map.addLayer({ id:"aor-line", type:"line", source:"aor",
          paint:{"line-color":"rgba(0,229,255,0.4)","line-width":1.5,"line-dasharray":[8,4]} });

        // Tactical grid
        const gridFeatures: any[] = [];
        for (let i=0;i<=GRID;i+=5) {
          const [lng]=g2ll(i,0); const [,lat]=g2ll(0,i);
          gridFeatures.push({type:"Feature",properties:{},geometry:{type:"LineString",coordinates:[[lng,SW[1]-0.05],[lng,NE[1]+0.05]]}});
          gridFeatures.push({type:"Feature",properties:{},geometry:{type:"LineString",coordinates:[[SW[0]-0.05,lat],[NE[0]+0.05,lat]]}});
        }
        map.addSource("grid",{type:"geojson",data:{type:"FeatureCollection",features:gridFeatures}});
        map.addLayer({id:"grid-lines",type:"line",source:"grid",
          paint:{"line-color":"rgba(0,200,255,0.07)","line-width":0.5}});

        // Zone fills
        map.addSource("zones",{type:"geojson",data:buildZonesGJ(state) as any});
        map.addLayer({id:"zones-fill",type:"fill",source:"zones",
          paint:{"fill-color":["get","color"],"fill-opacity":["get","opacity"]}});
        map.addLayer({id:"zones-line",type:"line",source:"zones",
          paint:{"line-color":["get","lineColor"],"line-width":1.5,"line-opacity":0.8}});

        // GPS denied
        map.addSource("gps",{type:"geojson",data:buildGpsGJ(state) as any});
        map.addLayer({id:"gps-fill",type:"fill",source:"gps",
          paint:{"fill-color":"rgba(136,68,255,0.18)","fill-pattern":undefined}});

        // Route corridors (wide glow)
        map.addSource("route-glow",{type:"geojson",data:buildRoutesGJ(state) as any});
        map.addLayer({id:"route-glow-line",type:"line",source:"route-glow",
          paint:{"line-color":["get","color"],"line-width":8,"line-opacity":0.08,"line-blur":4}});
        map.addLayer({id:"route-line",type:"line",source:"route-glow",
          paint:{"line-color":["get","color"],"line-width":1.8,"line-opacity":0.7,"line-dasharray":[5,3]}});

        // Task connectors
        map.addSource("task-links",{type:"geojson",data:buildTaskLinksGJ(state) as any});
        map.addLayer({id:"task-links-line",type:"line",source:"task-links",
          paint:{"line-color":["get","color"],"line-width":1,"line-dasharray":[3,4],"line-opacity":0.4}});

        // Task markers
        map.addSource("tasks",{type:"geojson",data:buildTasksGJ(state) as any});
        map.addLayer({id:"tasks-halo",type:"circle",source:"tasks",
          paint:{"circle-radius":10,"circle-color":"transparent","circle-stroke-color":["get","color"],"circle-stroke-width":1.5,"circle-stroke-opacity":0.5}});
        map.addLayer({id:"tasks-dot",type:"circle",source:"tasks",
          paint:{"circle-radius":5,"circle-color":["get","color"],"circle-opacity":0.9}});

        // Supply nodes (custom HTML markers)
        renderNodeMarkers(map, mgl, state);

        // Asset markers
        renderAssetMarkers(map, mgl, state, showRanges);
      });
    });

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      initRef.current = false;
    };
  }, []); // eslint-disable-line

  // Update on state change
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const mgl = (map as any)._mgl;
    try {
      (map.getSource("zones") as any)?.setData(buildZonesGJ(state));
      (map.getSource("gps") as any)?.setData(buildGpsGJ(state));
      (map.getSource("route-glow") as any)?.setData(buildRoutesGJ(state));
      (map.getSource("task-links") as any)?.setData(buildTaskLinksGJ(state));
      (map.getSource("tasks") as any)?.setData(buildTasksGJ(state));
      if (mgl) {
        renderNodeMarkers(map, mgl, state);
        renderAssetMarkers(map, mgl, state, showRanges);
      }
    } catch {}
  }, [state, showRanges]);

  return <div ref={containerRef} style={{width:"100%",height:"100%"}} />;
}

// ── GeoJSON builders ──────────────────────────────────────────────────────────

function buildZonesGJ(state: WorldState) {
  return {
    type:"FeatureCollection",
    features: state.zones.map(z => ({
      type:"Feature",
      properties: {
        color: z.type==="no_go"?"rgba(255,48,64,0.55)":z.type==="threat"?"rgba(255,102,0,0.35)":"rgba(136,68,255,0.25)",
        opacity: z.type==="no_go"?0.55:0.35,
        lineColor: z.type==="no_go"?"#ff3040":z.type==="threat"?"#ff6600":"#8844ff",
      },
      geometry:{ type:"MultiPolygon", coordinates:[z.cells.map(([x,y])=>[cellPoly(x,y)])] },
    })),
  };
}

function buildGpsGJ(state: WorldState) {
  return {
    type:"FeatureCollection",
    features: state.gpsDenied.map(([x,y])=>({
      type:"Feature", properties:{},
      geometry:{type:"Polygon",coordinates:[cellPoly(x,y)]},
    })),
  };
}

function buildRoutesGJ(state: WorldState) {
  return {
    type:"FeatureCollection",
    features: Object.values(state.assets)
      .filter(a=>a.route.length>1 && a.routeIdx<a.route.length-1)
      .map(a=>({
        type:"Feature",
        properties:{ color: ASSET_COLORS[a.id]??"#fff" },
        geometry:{ type:"LineString", coordinates:a.route.slice(a.routeIdx).map(([x,y])=>g2ll(x,y)) },
      })),
  };
}

function buildTaskLinksGJ(state: WorldState) {
  return {
    type:"FeatureCollection",
    features: Object.values(state.tasks)
      .filter(t=>!["complete","cancelled"].includes(t.status))
      .map(t=>({
        type:"Feature",
        properties:{ color: t.status==="pending"?"rgba(240,165,0,0.5)":t.status==="approved"?"rgba(0,229,255,0.4)":"rgba(0,255,136,0.4)" },
        geometry:{ type:"LineString", coordinates:[g2ll(t.pickup[0],t.pickup[1]),g2ll(t.dropoff[0],t.dropoff[1])] },
      })),
  };
}

function buildTasksGJ(state: WorldState) {
  const colorOf = (status: string) => ({pending:"#f0a500",approved:"#00e5ff",assigned:"#00e5ff",in_progress:"#44aaff",complete:"#00ff88",failed:"#ff3040",cancelled:"#444"} as Record<string,string>)[status]??"#888";
  return {
    type:"FeatureCollection",
    features: Object.values(state.tasks).flatMap(t=>[
      { type:"Feature", properties:{color:colorOf(t.status),kind:"pickup",id:t.id},
        geometry:{type:"Point",coordinates:g2ll(t.pickup[0],t.pickup[1])} },
      { type:"Feature", properties:{color:colorOf(t.status),kind:"dropoff",id:t.id},
        geometry:{type:"Point",coordinates:g2ll(t.dropoff[0],t.dropoff[1])} },
    ]),
  };
}

// ── Marker renderers ──────────────────────────────────────────────────────────

function renderNodeMarkers(map: any, mgl: any, state: WorldState) {
  if (!map._nodeMarkers) map._nodeMarkers = {};
  const markers = map._nodeMarkers as Record<string,any>;

  for (const node of Object.values(state.nodes)) {
    const style = NODE_STYLES[node.type] ?? NODE_STYLES.outpost;
    const [lng, lat] = g2ll(node.pos[0], node.pos[1]);

    const cargoItems = Object.entries(node.inventory) as [CargoType, number][];
    const criticals = cargoItems.filter(([c,v]) => v/node.capacity[c] < node.criticalThreshold);

    if (markers[node.id]) {
      markers[node.id].setLngLat([lng, lat]);
      // update inventory bars
      for (const [c] of cargoItems) {
        const bar = document.getElementById(`inv-${node.id}-${c}`);
        if (bar) {
          const pct = (node.inventory[c]/node.capacity[c])*100;
          bar.style.width = `${pct}%`;
          bar.style.background = pct<30?"#ff3040":pct<60?"#f0a500":CARGO_COLOR[c];
        }
      }
      // alert badge
      const badge = document.getElementById(`badge-${node.id}`);
      if (badge) badge.style.display = criticals.length>0?"block":"none";
    } else {
      const el = document.createElement("div");
      el.style.cssText = `font-family:'Share Tech Mono',monospace;color:${style.color};cursor:pointer;`;
      el.innerHTML = buildNodeHTML(node, style, cargoItems, criticals.length>0);
      markers[node.id] = new mgl.Marker({ element:el, anchor:"center" })
        .setLngLat([lng, lat]).addTo(map);
    }
  }
}

function buildNodeHTML(node: SupplyNode, style: {color:string;shape:string;size:number},
  cargoItems: [CargoType,number][], hasAlert: boolean): string {
  const s = style.size;
  const shapeEl = style.shape==="hexagon"
    ? `<svg width="${s*2}" height="${s*2}" viewBox="-${s} -${s} ${s*2} ${s*2}"><polygon points="${hexPath(0,0,s-2)}" fill="rgba(0,0,0,0.7)" stroke="${style.color}" stroke-width="1.5"/><text x="0" y="4" text-anchor="middle" fill="${style.color}" font-size="8" font-family="Share Tech Mono">${node.type.substring(0,3).toUpperCase()}</text></svg>`
    : style.shape==="square"
    ? `<svg width="${s*2}" height="${s*2}" viewBox="0 0 ${s*2} ${s*2}"><rect x="2" y="2" width="${s*2-4}" height="${s*2-4}" fill="rgba(0,0,0,0.7)" stroke="${style.color}" stroke-width="1.5"/><text x="${s}" y="${s+3}" text-anchor="middle" fill="${style.color}" font-size="7" font-family="Share Tech Mono">DEP</text></svg>`
    : `<svg width="${s*2}" height="${s*2}" viewBox="-${s} -${s} ${s*2} ${s*2}"><polygon points="0,-${s-2} ${s-2},0 0,${s-2} -${s-2},0" fill="rgba(0,0,0,0.7)" stroke="${style.color}" stroke-width="1.5"/></svg>`;

  const invBars = cargoItems.map(([c,v])=>{
    const pct = (v/100)*100;
    const bc = pct<30?"#ff3040":pct<60?"#f0a500":CARGO_COLOR[c];
    return `<div style="display:flex;align-items:center;gap:3px;margin-bottom:1px">
      <span style="color:${CARGO_COLOR[c]};font-size:7px;width:14px">${c.substring(0,3).toUpperCase()}</span>
      <div style="flex:1;height:3px;background:#1a2a1a;border-radius:1px">
        <div id="inv-${node.id}-${c}" style="height:100%;width:${pct}%;background:${bc};border-radius:1px;transition:width 0.5s"></div>
      </div>
      <span style="color:${bc};font-size:7px;width:22px;text-align:right">${Math.round(v)}%</span>
    </div>`;
  }).join("");

  return `
    <div style="position:relative">
      ${hasAlert?`<div id="badge-${node.id}" style="position:absolute;top:-6px;right:-6px;width:8px;height:8px;background:#ff3040;border-radius:50%;box-shadow:0 0 6px #ff3040;z-index:10;animation:pulse-ring 1s ease-out infinite"></div>`
                :`<div id="badge-${node.id}" style="display:none"></div>`}
      <div style="text-align:center;margin-bottom:2px">${shapeEl}</div>
      <div style="font-size:8px;color:${style.color};text-align:center;letter-spacing:0.1em;margin-bottom:3px;white-space:nowrap">${node.name}</div>
      <div style="width:90px;background:rgba(0,0,0,0.75);border:1px solid rgba(255,255,255,0.08);padding:4px;border-radius:2px">
        ${invBars}
      </div>
    </div>
  `;
}

function renderAssetMarkers(map: any, mgl: any, state: WorldState, showRanges: boolean) {
  if (!map._assetMarkers) map._assetMarkers = {};
  const markers = map._assetMarkers as Record<string,any>;
  // Range rings
  if (!map._rangeSource) {
    map.addSource("ranges",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    map.addLayer({id:"ranges-fill",type:"fill",source:"ranges",
      paint:{"fill-color":["get","color"],"fill-opacity":0.04}});
    map.addLayer({id:"ranges-line",type:"line",source:"ranges",
      paint:{"line-color":["get","color"],"line-width":1,"line-opacity":0.3,"line-dasharray":[4,4]}});
    map.addLayer({id:"heading-line",type:"line",source:"ranges",
      filter:["==",["get","kind"],"heading"],
      paint:{"line-color":["get","color"],"line-width":2,"line-opacity":0.6}});
    map._rangeSource = true;
  }

  const rangeFeatures: any[] = [];
  for (const asset of Object.values(state.assets)) {
    const color = ASSET_COLORS[asset.id]??"#fff";
    const [lng,lat] = g2ll(asset.pos[0], asset.pos[1]);

    if (showRanges) {
      const rangeCells = asset.battery / (asset.type==="drone"?1.2:0.6) * 0.4;
      const dLng = (NE[0]-SW[0])/(GRID-1) * rangeCells;
      const dLat = (NE[1]-SW[1])/(GRID-1) * rangeCells;
      const pts: [number,number][] = [];
      for (let a=0;a<=360;a+=10) pts.push([lng+dLng*Math.cos(a*Math.PI/180), lat+dLat*Math.sin(a*Math.PI/180)]);
      pts.push(pts[0]);
      rangeFeatures.push({type:"Feature",properties:{color,kind:"range"},
        geometry:{type:"Polygon",coordinates:[pts]}});
    }

    // Heading arrow
    if (asset.route.length>1 && asset.routeIdx<asset.route.length-1) {
      const next = asset.route[asset.routeIdx+1];
      const [nlng,nlat]=g2ll(next[0],next[1]);
      rangeFeatures.push({type:"Feature",properties:{color,kind:"heading"},
        geometry:{type:"LineString",coordinates:[[lng,lat],[nlng,nlat]]}});
    }

    if (markers[asset.id]) {
      markers[asset.id].setLngLat([lng,lat]);
      const bar = document.getElementById(`ab-${asset.id}`);
      if (bar) { const bc=asset.battery>40?"#00ff88":asset.battery>15?"#f0a500":"#ff3040"; bar.style.width=`${asset.battery}%`; bar.style.background=bc; }
      const stEl = document.getElementById(`ast-${asset.id}`);
      if (stEl) stEl.textContent=asset.status.toUpperCase();
      const cargoEl = document.getElementById(`ac-${asset.id}`);
      if (cargoEl) cargoEl.textContent=asset.cargo.length?asset.cargo.map(c=>`${c.quantity}×${c.type.substring(0,3).toUpperCase()}`).join(" "):"EMPTY";
    } else {
      const el = document.createElement("div");
      el.style.cssText = `font-family:'Share Tech Mono',monospace;color:${color}`;
      const bc = asset.battery>40?"#00ff88":asset.battery>15?"#f0a500":"#ff3040";
      el.innerHTML = `
        <div style="position:relative;text-align:center">
          <div style="font-size:8px;color:${color};letter-spacing:0.1em;margin-bottom:2px">${asset.id}</div>
          <div style="width:36px;height:36px;border-radius:50%;border:1.5px solid ${color};background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 0 12px ${color}44;position:relative">
            <div style="position:absolute;inset:-5px;border-radius:50%;border:1px solid ${color}33"></div>
            ${asset.type==="drone"?"✦":"◈"}
          </div>
          <div id="ast-${asset.id}" style="font-size:7px;color:${color}88;margin-top:2px;letter-spacing:0.08em">${asset.status.toUpperCase()}</div>
          <div id="ac-${asset.id}" style="font-size:7px;color:#888;white-space:nowrap">${asset.cargo.length?asset.cargo.map(c=>`${c.quantity}×${c.type.substring(0,3).toUpperCase()}`).join(" "):"EMPTY"}</div>
          <div style="width:36px;height:2px;background:#1a2a1a;margin:2px 0;border-radius:1px">
            <div id="ab-${asset.id}" style="height:100%;width:${asset.battery}%;background:${bc};border-radius:1px;transition:width 0.4s"></div>
          </div>
        </div>`;
      markers[asset.id] = new mgl.Marker({element:el,anchor:"center"}).setLngLat([lng,lat]).addTo(map);
    }
  }
  try { (map.getSource("ranges") as any)?.setData({type:"FeatureCollection",features:rangeFeatures}); } catch {}
}
