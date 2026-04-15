"use client";
import type { CountyData } from "@/lib/types";
import { ALERT_COLOR } from "@/lib/types";

interface Props {
  county: CountyData;
  onClose: () => void;
}

function Bar({ value, max, color, label, sub }: { value: number; max: number; color: string; label: string; sub: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "'Share Tech Mono',monospace", fontSize: 8, marginBottom: 2 }}>
        <span style={{ color: "rgba(255,255,255,0.5)" }}>{label}</span>
        <span style={{ color }}>{value.toLocaleString()} <span style={{ color: "rgba(255,255,255,0.25)" }}>{sub}</span></span>
      </div>
      <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 0.5s", boxShadow: `0 0 6px ${color}66` }} />
      </div>
    </div>
  );
}

export default function CountyDetailPanel({ county, onClose }: Props) {
  const riskColor = county.riskScore > 0.65 ? "#ff2020" : county.riskScore > 0.45 ? "#ff6600" : county.riskScore > 0.25 ? "#f0a500" : "#ffcc00";

  return (
    <div style={{
      position: "absolute", top: 50, left: 230, zIndex: 200, width: 310,
      background: "rgba(5,9,16,0.97)", border: "1px solid rgba(255,120,0,0.25)",
      borderRadius: 3, fontFamily: "'Share Tech Mono',monospace",
      backdropFilter: "blur(16px)", boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    }}>
      {/* Header */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,120,0,0.15)", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 13, color: "rgba(255,220,160,0.95)", fontWeight: 600, letterSpacing: "0.08em" }}>
            {county.name.toUpperCase()} COUNTY
          </div>
          <div style={{ fontSize: 8, color: "rgba(255,120,0,0.45)", marginTop: 2 }}>
            FIPS {county.fips} · STATE: {county.state}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
          <div style={{ fontSize: 20, color: riskColor, fontWeight: 700, lineHeight: 1 }}>
            {(county.riskScore * 100).toFixed(0)}
          </div>
          <div style={{ fontSize: 7, color: riskColor, letterSpacing: "0.12em" }}>RISK SCORE</div>
          <button onClick={onClose} style={{ marginTop: 2, background: "none", border: "none", color: "rgba(255,120,0,0.4)", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>✕</button>
        </div>
      </div>

      {/* Alert status */}
      {county.alerts.length > 0 && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,120,0,0.1)", background: `${ALERT_COLOR[county.alertLevel]}0e` }}>
          <div style={{ fontSize: 8, color: "rgba(255,120,0,0.4)", letterSpacing: "0.15em", marginBottom: 5 }}>ACTIVE ALERTS ({county.alerts.length})</div>
          {county.alerts.slice(0, 3).map((a, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4, paddingLeft: 6, borderLeft: `2px solid ${ALERT_COLOR[a.level]}` }}>
              <div>
                <div style={{ fontSize: 9, color: ALERT_COLOR[a.level] }}>{a.event}</div>
                <div style={{ fontSize: 7.5, color: "rgba(255,255,255,0.3)", marginTop: 1 }}>{a.headline.slice(0, 60)}...</div>
                <div style={{ fontSize: 7, color: "rgba(255,255,255,0.2)", marginTop: 1 }}>
                  Expires: {new Date(a.expiresAt).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Population & demographics */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,120,0,0.1)" }}>
        <div style={{ fontSize: 8, color: "rgba(255,120,0,0.4)", letterSpacing: "0.15em", marginBottom: 8 }}>POPULATION & VULNERABILITY</div>
        <Bar value={county.population} max={1100000} color="#00e5ff" label="TOTAL POPULATION" sub="" />
        <Bar value={Math.round(county.elderlyPct * 100) / 100} max={30} color="#f0a500" label="ELDERLY (65+)" sub={`% · ${county.elderlyCount?.toLocaleString() ?? "—"} persons`} />
        <Bar value={Math.round(county.noVehiclePct * 100) / 100} max={20} color="#ff6600" label="NO VEHICLE" sub={`% · ${county.noVehicleHouseholds?.toLocaleString() ?? "—"} households`} />
        <Bar value={Math.round(county.povertyPct * 100) / 100} max={35} color="#ff3040" label="POVERTY RATE" sub={`% · ${county.povertyCount?.toLocaleString() ?? "—"} persons`} />
        <div style={{ marginTop: 4, padding: "5px 8px", background: "rgba(0,0,0,0.3)", border: `1px solid rgba(255,120,0,0.1)`, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 8, color: "rgba(255,255,255,0.35)" }}>VULNERABILITY INDEX</span>
          <span style={{ fontSize: 9, color: county.vulnerabilityScore > 0.5 ? "#ff6600" : "#f0a500", fontWeight: 700 }}>{(county.vulnerabilityScore * 100).toFixed(0)}%</span>
        </div>
      </div>

      {/* Critical facilities */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,120,0,0.1)" }}>
        <div style={{ fontSize: 8, color: "rgba(255,120,0,0.4)", letterSpacing: "0.15em", marginBottom: 6 }}>
          CRITICAL FACILITIES ({county.hospitals.length} hospitals)
        </div>
        {county.hospitals.length === 0 ? (
          <div style={{ fontSize: 8, color: "rgba(255,255,255,0.2)" }}>No hospitals in HIFLD dataset for this county</div>
        ) : (
          county.hospitals.slice(0, 5).map((h, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid rgba(255,120,0,0.05)", fontSize: 8 }}>
              <span style={{ color: "rgba(255,80,80,0.8)" }}>🏥 {h.name?.slice(0, 28)}</span>
              <span style={{ color: "rgba(255,255,255,0.25)" }}>{h.beds > 0 ? `${h.beds} beds` : h.type?.slice(0, 12)}</span>
            </div>
          ))
        )}
      </div>

      {/* FEMA declarations */}
      <div style={{ padding: "8px 12px", borderBottom: county.hasDeclaration ? "1px solid rgba(255,120,0,0.1)" : "none" }}>
        <div style={{ fontSize: 8, color: "rgba(255,120,0,0.4)", letterSpacing: "0.15em", marginBottom: 4 }}>FEMA STATUS</div>
        {county.hasDeclaration ? (
          county.declarations.slice(0, 3).map((d, i) => (
            <div key={i} style={{ padding: "4px 6px", marginBottom: 3, background: "rgba(255,165,0,0.07)", border: "1px solid rgba(255,165,0,0.15)", fontSize: 8 }}>
              <div style={{ color: "#ffcc00" }}>DR-{d.disasterNumber} · {d.incidentType}</div>
              <div style={{ color: "rgba(255,255,255,0.3)", marginTop: 1 }}>{d.title?.slice(0, 45)} · {new Date(d.declarationDate).toLocaleDateString()}</div>
            </div>
          ))
        ) : (
          <div style={{ fontSize: 8, color: "rgba(255,255,255,0.2)" }}>No active disaster declarations</div>
        )}
      </div>

      {/* Risk breakdown */}
      <div style={{ padding: "8px 12px" }}>
        <div style={{ fontSize: 8, color: "rgba(255,120,0,0.4)", letterSpacing: "0.15em", marginBottom: 6 }}>RISK SCORE BREAKDOWN</div>
        <div style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", lineHeight: 2, display: "grid", gridTemplateColumns: "1fr auto auto" }}>
          <span>Weather severity</span><span style={{ color: "rgba(0,200,255,0.4)", textAlign: "right", marginRight: 8 }}>×0.35</span>
          <span style={{ color: county.alertLevel !== "none" ? "#ff6600" : "#333" }}>{county.alertLevel.toUpperCase()}</span>
          <span>FEMA declaration</span><span style={{ color: "rgba(0,200,255,0.4)", textAlign: "right", marginRight: 8 }}>×0.20</span>
          <span style={{ color: county.hasDeclaration ? "#ffcc00" : "#333" }}>{county.hasDeclaration ? "YES" : "NO"}</span>
          <span>Population exposure</span><span style={{ color: "rgba(0,200,255,0.4)", textAlign: "right", marginRight: 8 }}>×0.15</span>
          <span style={{ color: "rgba(255,255,255,0.35)" }}>{county.population.toLocaleString()}</span>
          <span>Vulnerability index</span><span style={{ color: "rgba(0,200,255,0.4)", textAlign: "right", marginRight: 8 }}>×0.20</span>
          <span style={{ color: county.vulnerabilityScore > 0.4 ? "#ff6600" : "rgba(255,255,255,0.35)" }}>{(county.vulnerabilityScore * 100).toFixed(0)}%</span>
          <span>Hospital density</span><span style={{ color: "rgba(0,200,255,0.4)", textAlign: "right", marginRight: 8 }}>×0.10</span>
          <span style={{ color: county.hospitals.length > 2 ? "#ff3040" : "rgba(255,255,255,0.35)" }}>{county.hospitals.length} facilities</span>
        </div>
        <div style={{ marginTop: 8, padding: "6px 8px", background: `${riskColor}12`, border: `1px solid ${riskColor}33`, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 8, color: "rgba(255,255,255,0.35)" }}>COMPOSITE RISK SCORE</span>
          <span style={{ fontSize: 11, color: riskColor, fontWeight: 700 }}>{(county.riskScore * 100).toFixed(1)}%</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 8, color: "rgba(255,255,255,0.2)" }}>
          Impacted population estimate: {county.impactedPopulation?.toLocaleString() ?? "—"}
        </div>
      </div>
    </div>
  );
}
