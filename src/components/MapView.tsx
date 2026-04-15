"use client";
import React, { useMemo } from "react";
import type { WorldState } from "@/lib/types";

const CELL = 28;
const ASSET_COLORS: Record<string, string> = {
  D1: "#38bdf8", D2: "#f472b6", G1: "#4ade80",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "#e8a020",
  assigned: "#38bdf8",
  in_progress: "#38bdf8",
  complete: "#22c55e",
  failed: "#ef4444",
};

interface Props { state: WorldState }

export default function MapView({ state }: Props) {
  const G = state.gridSize;
  const W = G * CELL;

  const gpuSet = useMemo(() => {
    const s = new Set<string>();
    state.gpsDenied.forEach(([x,y]) => s.add(`${x},${y}`));
    return s;
  }, [state.gpsDenied]);

  const zoneMap = useMemo(() => {
    const m = new Map<string, { color: string; stroke: string }>();
    for (const zone of state.zones) {
      const styles = {
        threat:    { color: "rgba(239,68,68,0.18)",   stroke: "#ef444466" },
        no_go:     { color: "rgba(239,68,68,0.35)",   stroke: "#ef4444aa" },
        gps_denied:{ color: "rgba(139,92,246,0.18)",  stroke: "#8b5cf666" },
      }[zone.type] ?? { color: "#33333322", stroke: "#555" };
      zone.cells.forEach(([x,y]) => m.set(`${x},${y}`, styles));
    }
    return m;
  }, [state.zones]);

  return (
    <div className="panel w-full h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>OPERATIONAL AREA</span>
        <span style={{ color: "#4a5a4a" }}>T={String(state.tick).padStart(3,"0")} | {G}×{G} GRID</span>
      </div>
      <div className="flex-1 overflow-auto flex items-center justify-center p-2"
           style={{ background: "#080b0e" }}>
        <svg
          width={W} height={W}
          style={{ display: "block", maxWidth: "100%", maxHeight: "100%" }}
          viewBox={`0 0 ${W} ${W}`}
        >
          {/* Grid lines */}
          {Array.from({ length: G+1 }, (_,i) => (
            <React.Fragment key={i}>
              <line x1={i*CELL} y1={0} x2={i*CELL} y2={W} stroke="#1a2a1a" strokeWidth="0.5"/>
              <line x1={0} y1={i*CELL} x2={W} y2={i*CELL} stroke="#1a2a1a" strokeWidth="0.5"/>
            </React.Fragment>
          ))}

          {/* GPS denied */}
          {Array.from(gpuSet).map(k => {
            const [x,y] = k.split(",").map(Number);
            return <rect key={k} x={x*CELL} y={y*CELL} width={CELL} height={CELL}
              fill="rgba(139,92,246,0.12)" />;
          })}

          {/* Zone cells */}
          {Array.from(zoneMap.entries()).map(([k, s]) => {
            const [x,y] = k.split(",").map(Number);
            return <rect key={k} x={x*CELL} y={y*CELL} width={CELL} height={CELL}
              fill={s.color} stroke={s.stroke} strokeWidth="0.5"/>;
          })}

          {/* Tasks */}
          {Object.values(state.tasks).map(task => {
            const c = STATUS_COLORS[task.status] ?? "#888";
            const [px,py] = task.pickup;
            const [dx,dy] = task.dropoff;
            const pcx = px*CELL+CELL/2, pcy = py*CELL+CELL/2;
            const dcx = dx*CELL+CELL/2, dcy = dy*CELL+CELL/2;
            return (
              <g key={task.id}>
                <line x1={pcx} y1={pcy} x2={dcx} y2={dcy}
                  stroke={c} strokeWidth="1" strokeDasharray="4 3" opacity="0.3"/>
                {/* pickup square */}
                <rect x={pcx-5} y={pcy-5} width={10} height={10}
                  fill="none" stroke={c} strokeWidth="1.5"/>
                {/* dropoff triangle */}
                <polygon
                  points={`${dcx},${dcy-7} ${dcx-6},${dcy+5} ${dcx+6},${dcy+5}`}
                  fill="none" stroke={c} strokeWidth="1.5"/>
                <text x={pcx} y={pcy-8} textAnchor="middle"
                  fill={c} fontSize="8" fontFamily="'Share Tech Mono',monospace">
                  {task.id}
                </text>
              </g>
            );
          })}

          {/* Asset routes */}
          {Object.values(state.assets).map(asset => {
            if (!asset.route.length || asset.routeIdx >= asset.route.length-1) return null;
            const remaining = asset.route.slice(asset.routeIdx);
            const color = ASSET_COLORS[asset.id] ?? "#fff";
            const pts = remaining.map(([x,y]) => `${x*CELL+CELL/2},${y*CELL+CELL/2}`).join(" ");
            return (
              <polyline key={asset.id+"-route"} points={pts}
                fill="none" stroke={color} strokeWidth="1.5"
                strokeDasharray="5 3" opacity="0.5"/>
            );
          })}

          {/* Assets */}
          {Object.values(state.assets).map(asset => {
            const color = ASSET_COLORS[asset.id] ?? "#fff";
            const [x,y] = asset.pos;
            const cx = x*CELL+CELL/2, cy = y*CELL+CELL/2;
            return (
              <g key={asset.id}>
                <circle cx={cx} cy={cy} r={10}
                  fill={color+"22"} stroke={color} strokeWidth="1.5"/>
                <text x={cx} y={cy+4} textAnchor="middle"
                  fill={color} fontSize="9" fontFamily="'Share Tech Mono',monospace"
                  fontWeight="600">
                  {asset.id}
                </text>
                {/* battery arc */}
                <circle cx={cx} cy={cy} r={13}
                  fill="none" stroke={color} strokeWidth="1"
                  strokeDasharray={`${asset.battery/100*81.7} 81.7`}
                  strokeDashoffset="20" opacity="0.4"
                  transform={`rotate(-90 ${cx} ${cy})`}/>
              </g>
            );
          })}

          {/* Axes labels */}
          {Array.from({length: G}, (_,i) => i % 5 === 0 ? (
            <React.Fragment key={i}>
              <text x={i*CELL+CELL/2} y={W-2} textAnchor="middle"
                fill="#2a3a2a" fontSize="7" fontFamily="monospace">{i}</text>
              <text x={2} y={i*CELL+CELL/2+3}
                fill="#2a3a2a" fontSize="7" fontFamily="monospace">{i}</text>
            </React.Fragment>
          ) : null)}
        </svg>
      </div>
      {/* Legend */}
      <div className="flex gap-4 px-3 py-2" style={{ borderTop:"1px solid var(--border)", fontSize:9, color:"var(--text-dim)", fontFamily:"'Share Tech Mono',monospace" }}>
        <span><span style={{color:"#ef4444"}}>■</span> THREAT</span>
        <span><span style={{color:"#ef4444CC"}}>■</span> NO-GO</span>
        <span><span style={{color:"#8b5cf6"}}>■</span> GPS-DENY</span>
        <span><span style={{color:"#e8a020"}}>□</span> PICKUP</span>
        <span><span style={{color:"#e8a020"}}>△</span> DROPOFF</span>
      </div>
    </div>
  );
}
