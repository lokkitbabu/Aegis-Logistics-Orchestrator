"use client";
import { useEffect, useRef } from "react";
import type { WorldState, Vec2 } from "@/lib/types";

// ── Geo projection: Nevada Test & Training Range (Tonopah area) ───────────────
const GRID = 20;
const SW: [number, number] = [-116.18, 37.08]; // [lng, lat]
const NE: [number, number] = [-115.55, 37.58];

function g2ll(x: number, y: number): [number, number] {
  return [
    SW[0] + (x / (GRID - 1)) * (NE[0] - SW[0]),
    SW[1] + (y / (GRID - 1)) * (NE[1] - SW[1]),
  ];
}

function cellPolygon(cx: number, cy: number): number[][] {
  const dw = (NE[0] - SW[0]) / GRID;
  const dh = (NE[1] - SW[1]) / GRID;
  const [lng, lat] = g2ll(cx, cy);
  return [
    [lng - dw/2, lat - dh/2],
    [lng + dw/2, lat - dh/2],
    [lng + dw/2, lat + dh/2],
    [lng - dw/2, lat + dh/2],
    [lng - dw/2, lat - dh/2],
  ];
}

const ASSET_COLORS: Record<string, string> = {
  D1: "#00e5ff", D2: "#ff44aa", G1: "#00ff88",
};

const TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

function buildZoneGeoJSON(state: WorldState) {
  const features: any[] = [];
  for (const zone of state.zones) {
    const color = zone.type === "no_go" ? "#ff3040" : zone.type === "threat" ? "#ff6600" : "#8844ff";
    const opacity = zone.type === "no_go" ? 0.45 : 0.28;
    features.push({
      type: "Feature",
      properties: { color, opacity, type: zone.type },
      geometry: {
        type: "MultiPolygon",
        coordinates: [zone.cells.map(([x,y]) => [cellPolygon(x,y)])],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function buildGPSGeoJSON(state: WorldState) {
  return {
    type: "FeatureCollection",
    features: state.gpsDenied.map(([x,y]) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [cellPolygon(x,y)] },
    })),
  };
}

function buildRoutesGeoJSON(state: WorldState) {
  return {
    type: "FeatureCollection",
    features: Object.values(state.assets)
      .filter(a => a.route.length > 1 && a.routeIdx < a.route.length - 1)
      .map(a => ({
        type: "Feature",
        properties: { color: ASSET_COLORS[a.id] ?? "#fff" },
        geometry: {
          type: "LineString",
          coordinates: a.route.slice(a.routeIdx).map(([x,y]) => g2ll(x,y)),
        },
      })),
  };
}

function buildTasksGeoJSON(state: WorldState) {
  const features: any[] = [];
  for (const task of Object.values(state.tasks)) {
    const color = ({ pending:"#f0a500", assigned:"#00e5ff", in_progress:"#00e5ff", complete:"#00ff88", failed:"#ff3040" } as Record<string,string>)[task.status] ?? "#888";
    features.push({
      type: "Feature",
      properties: { id: task.id, kind: "pickup", priority: task.priority, status: task.status, color },
      geometry: { type: "Point", coordinates: g2ll(task.pickup[0], task.pickup[1]) },
    });
    features.push({
      type: "Feature",
      properties: { id: task.id, kind: "dropoff", priority: task.priority, status: task.status, color },
      geometry: { type: "Point", coordinates: g2ll(task.dropoff[0], task.dropoff[1]) },
    });
  }
  return { type: "FeatureCollection", features };
}

interface Props { state: WorldState }

export default function MapView({ state }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<Record<string, any>>({});
  const initRef = useRef(false);

  // Initialize map once
  useEffect(() => {
    if (initRef.current || !containerRef.current) return;
    initRef.current = true;

    import("maplibre-gl").then(({ default: maplibregl }) => {
      const center: [number, number] = [
        (SW[0] + NE[0]) / 2,
        (SW[1] + NE[1]) / 2,
      ];

      const map = new maplibregl.Map({
        container: containerRef.current!,
        style: {
          version: 8,
          sources: {
            carto: {
              type: "raster",
              tiles: [
                "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
                "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
                "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
              ],
              tileSize: 256,
              attribution: "© CartoDB",
            },
          },
          layers: [{ id: "carto-tiles", type: "raster", source: "carto" }],
        },
        center,
        zoom: 9.2,
        bearing: 0,
        pitch: 0,
        attributionControl: false,
      });

      mapRef.current = map;

      map.on("load", () => {
        // GPS denied source/layer
        map.addSource("gps-denied", { type: "geojson", data: buildGPSGeoJSON(state) as any });
        map.addLayer({
          id: "gps-denied-fill",
          type: "fill",
          source: "gps-denied",
          paint: { "fill-color": "#8844ff", "fill-opacity": 0.18 },
        });

        // Zones source/layers
        map.addSource("zones", { type: "geojson", data: buildZoneGeoJSON(state) as any });
        map.addLayer({
          id: "zones-fill",
          type: "fill",
          source: "zones",
          paint: {
            "fill-color": ["get", "color"],
            "fill-opacity": ["get", "opacity"],
          },
        });
        map.addLayer({
          id: "zones-line",
          type: "line",
          source: "zones",
          paint: {
            "line-color": ["get", "color"],
            "line-width": 1.5,
            "line-opacity": 0.7,
          },
        });

        // AOR boundary
        map.addSource("aor", {
          type: "geojson",
          data: {
            type: "Feature" as const,
            properties: {},
            geometry: {
              type: "Polygon" as const,
              coordinates: [[
                [SW[0]-0.02, SW[1]-0.02],
                [NE[0]+0.02, SW[1]-0.02],
                [NE[0]+0.02, NE[1]+0.02],
                [SW[0]-0.02, NE[1]+0.02],
                [SW[0]-0.02, SW[1]-0.02],
              ]],
            },
          },
        });
        map.addLayer({
          id: "aor-line",
          type: "line",
          source: "aor",
          paint: {
            "line-color": "rgba(0,229,255,0.35)",
            "line-width": 1,
            "line-dasharray": [8, 4],
          },
        });

        // Tactical grid lines (every 5 cells)
        const gridLines: number[][][] = [];
        for (let i = 0; i <= GRID; i += 5) {
          const [lng0] = g2ll(i, 0); const [, lat0] = g2ll(0, i);
          gridLines.push([[lng0, SW[1]-0.05], [lng0, NE[1]+0.05]]);
          gridLines.push([[SW[0]-0.05, lat0], [NE[0]+0.05, lat0]]);
        }
        map.addSource("grid", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: gridLines.map(coords => ({
              type: "Feature", properties: {},
              geometry: { type: "LineString", coordinates: coords },
            })),
          },
        });
        map.addLayer({
          id: "grid-lines",
          type: "line",
          source: "grid",
          paint: { "line-color": "rgba(0,200,255,0.06)", "line-width": 0.5 },
        });

        // Routes
        map.addSource("routes", { type: "geojson", data: buildRoutesGeoJSON(state) as any });
        map.addLayer({
          id: "routes-line",
          type: "line",
          source: "routes",
          paint: {
            "line-color": ["get", "color"],
            "line-width": 1.8,
            "line-opacity": 0.65,
            "line-dasharray": [6, 3],
          },
        });

        // Task connector lines
        map.addSource("task-connectors", {
          type: "geojson",
          data: {
            type: "FeatureCollection" as const,
            features: Object.values(state.tasks).map(t => ({
              type: "Feature" as const,
              properties: { color: ({ pending:"#f0a50044", assigned:"#00e5ff33", in_progress:"#00e5ff33", complete:"#00ff8833", failed:"#ff304433" } as Record<string,string>)[t.status] ?? "#88888833" },
              geometry: {
                type: "LineString",
                coordinates: [g2ll(t.pickup[0],t.pickup[1]), g2ll(t.dropoff[0],t.dropoff[1])],
              },
            })),
          },
        });
        map.addLayer({
          id: "task-connectors-line",
          type: "line",
          source: "task-connectors",
          paint: {
            "line-color": ["get","color"],
            "line-width": 1,
            "line-dasharray": [4,4],
          },
        });

        // Task symbols
        map.addSource("tasks", { type: "geojson", data: buildTasksGeoJSON(state) as any });
        map.addLayer({
          id: "tasks-circle",
          type: "circle",
          source: "tasks",
          paint: {
            "circle-radius": ["case", ["==", ["get","kind"],"pickup"], 6, 5],
            "circle-color": ["get", "color"],
            "circle-opacity": 0.85,
            "circle-stroke-color": ["get","color"],
            "circle-stroke-width": 1.5,
            "circle-stroke-opacity": 1,
          },
        });
        map.addLayer({
          id: "tasks-label",
          type: "symbol",
          source: "tasks",
          layout: {
            "text-field": ["concat", ["get","id"], " ", ["case",["==",["get","kind"],"pickup"],"↓","★"]],
            "text-font": ["Open Sans Regular"],
            "text-size": 9,
            "text-offset": [0, -1.2],
            "text-anchor": "bottom",
          },
          paint: { "text-color": ["get","color"], "text-opacity": 0.85 },
        });

        // Asset markers (custom HTML)
        renderAssetMarkers(map, maplibregl, state);

        // Store maplibregl ref for updates
        (mapRef.current as any)._mgl = maplibregl;
      });
    });

    return () => {
      Object.values(markersRef.current).forEach((m: any) => m.remove());
      markersRef.current = {};
      mapRef.current?.remove();
      mapRef.current = null;
      initRef.current = false;
    };
  }, []); // eslint-disable-line

  // Update sources when state changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const mgl = map._mgl;

    try {
      (map.getSource("zones") as any)?.setData(buildZoneGeoJSON(state));
      (map.getSource("gps-denied") as any)?.setData(buildGPSGeoJSON(state));
      (map.getSource("routes") as any)?.setData(buildRoutesGeoJSON(state));
      (map.getSource("tasks") as any)?.setData(buildTasksGeoJSON(state));
      (map.getSource("task-connectors") as any)?.setData({
        type: "FeatureCollection",
        features: Object.values(state.tasks).map(t => ({
          type: "Feature",
          properties: { color: ({ pending:"#f0a50044", assigned:"#00e5ff33", in_progress:"#00e5ff33", complete:"#00ff8833", failed:"#ff304433" } as Record<string,string>)[t.status] ?? "#88888833" },
          geometry: {
            type: "LineString",
            coordinates: [g2ll(t.pickup[0],t.pickup[1]), g2ll(t.dropoff[0],t.dropoff[1])],
          },
        })),
      });

      if (mgl) renderAssetMarkers(map, mgl, state);
    } catch { /* map may not be ready */ }
  }, [state]);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
  );
}

function renderAssetMarkers(map: any, mgl: any, state: WorldState) {
  // We use a global registry on the map object
  if (!map._assetMarkers) map._assetMarkers = {};
  const markers = map._assetMarkers as Record<string, any>;

  for (const asset of Object.values(state.assets)) {
    const color = ASSET_COLORS[asset.id] ?? "#fff";
    const [lng, lat] = g2ll(asset.pos[0], asset.pos[1]);

    if (markers[asset.id]) {
      markers[asset.id].setLngLat([lng, lat]);
      // Update battery bar
      const bar = document.getElementById(`batt-${asset.id}`);
      if (bar) {
        const pct = asset.battery;
        const bc = pct > 40 ? "#00ff88" : pct > 15 ? "#f0a500" : "#ff3040";
        bar.style.width = `${pct}%`;
        bar.style.background = bc;
      }
      const statusEl = document.getElementById(`status-${asset.id}`);
      if (statusEl) statusEl.textContent = asset.status.toUpperCase();
      // Update ring glow on active
      const ring = document.getElementById(`ring-${asset.id}`);
      if (ring) ring.style.boxShadow = asset.currentTask ? `0 0 12px ${color}66` : "none";
    } else {
      const el = document.createElement("div");
      el.className = "asset-marker";
      el.style.color = color;
      el.innerHTML = `
        <div class="asset-label">${asset.id} · ${asset.type.toUpperCase()}</div>
        <div class="asset-ring" id="ring-${asset.id}" style="border-color:${color};color:${color}">
          <div class="pulse-ring" style="border-color:${color}66"></div>
          ${asset.type === "drone" ? "✦" : "◈"}
        </div>
        <div id="status-${asset.id}" class="asset-status">${asset.status.toUpperCase()}</div>
        <div style="position:absolute;bottom:-22px;left:50%;transform:translateX(-50%);width:32px;height:2px;background:#1a2a2a;border-radius:1px">
          <div id="batt-${asset.id}" style="height:100%;width:${asset.battery}%;background:${asset.battery>40?"#00ff88":asset.battery>15?"#f0a500":"#ff3040"};border-radius:1px;transition:width 0.3s"></div>
        </div>
      `;
      markers[asset.id] = new mgl.Marker({ element: el, anchor: "center" })
        .setLngLat([lng, lat])
        .addTo(map);
    }
  }
}
