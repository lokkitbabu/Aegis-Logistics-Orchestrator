/**
 * Generates a structured incident report from current system state.
 * Returns HTML string suitable for printing or saving as a PDF.
 */
import type { SystemState, ResponseTask, CountyData } from "./types";
import { TASK_ICON, ALERT_COLOR } from "./types";

export function generateIncidentReport(state: SystemState): string {
  const now = new Date();
  const top10 = Object.values(state.counties)
    .filter(c => c.population > 0)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10);

  const activeTasks = Object.values(state.tasks).filter(t => !["complete", "cancelled"].includes(t.status));
  const highPriority = activeTasks.filter(t => t.priorityScore >= 60);
  const covered = highPriority.filter(t => t.assignedResourceId);
  const uncovered = highPriority.filter(t => !t.assignedResourceId);

  const sf = state.shortfallAnalysis;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>AEGIS Incident Report — ${now.toLocaleDateString()}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Courier New', monospace; background: #fff; color: #111; padding: 32px; font-size: 10pt; }
  h1 { font-size: 16pt; text-transform: uppercase; letter-spacing: 0.2em; border-bottom: 3px solid #111; padding-bottom: 8px; margin-bottom: 6px; }
  h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.2em; margin: 20px 0 8px; border-bottom: 1px solid #999; padding-bottom: 3px; }
  .meta { font-size: 8pt; color: #555; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; margin-bottom: 16px; }
  th { background: #111; color: #fff; padding: 5px 8px; text-align: left; font-size: 8pt; letter-spacing: 0.1em; text-transform: uppercase; }
  td { padding: 4px 8px; border-bottom: 1px solid #ddd; }
  tr:nth-child(even) td { background: #f8f8f8; }
  .risk-high { color: #cc0000; font-weight: bold; }
  .risk-med  { color: #cc6600; }
  .risk-low  { color: #007700; }
  .badge { display: inline-block; padding: 1px 5px; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.1em; font-weight: bold; }
  .badge-red    { background: #ffdddd; color: #cc0000; border: 1px solid #cc0000; }
  .badge-orange { background: #fff0dd; color: #cc6600; border: 1px solid #cc6600; }
  .badge-green  { background: #ddffdd; color: #007700; border: 1px solid #007700; }
  .badge-yellow { background: #fffbdd; color: #887700; border: 1px solid #887700; }
  .shortfall { background: #ffeeee; border: 2px solid #cc0000; padding: 10px 14px; margin: 12px 0; }
  .shortfall p { margin: 3px 0; font-size: 9pt; }
  .footer { margin-top: 32px; font-size: 7pt; color: #999; border-top: 1px solid #ddd; padding-top: 8px; }
  @media print { body { padding: 16px; } }
</style>
</head>
<body>

<h1>AEGIS — Incident Status Report</h1>
<div class="meta">
  Generated: ${now.toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" })} at ${now.toLocaleTimeString()}<br>
  Area of Responsibility: Georgia State Emergency Operations<br>
  Data Sources: NWS Active Alerts · OpenFEMA Declarations · Census ACS 2022 · HIFLD Hospitals<br>
  Active Alerts: ${state.alerts.length} · Counties Under Alert: ${Object.values(state.counties).filter(c => c.alertLevel !== "none").length} · Response Tasks: ${activeTasks.length}
</div>

${sf && sf.uncoveredTasks > 0 ? `
<div class="shortfall">
  <p><strong>⚠ RESOURCE SHORTFALL IDENTIFIED</strong></p>
  <p>${sf.summary}</p>
  <p>Covered: ${sf.coveredTasks} / ${sf.highPriorityTasks} high-priority tasks</p>
</div>` : `
<div style="background:#eeffee;border:2px solid #007700;padding:10px 14px;margin:12px 0;">
  <p><strong>✓ RESOURCE COVERAGE ADEQUATE</strong></p>
  <p>All ${sf?.highPriorityTasks ?? 0} high-priority tasks assigned.</p>
</div>`}

<h2>Priority County Risk Rankings (Top 10)</h2>
<table>
  <thead><tr><th>#</th><th>County</th><th>Risk Score</th><th>Alert Level</th><th>Population</th><th>Vulnerability</th><th>Hospitals</th><th>FEMA</th></tr></thead>
  <tbody>
  ${top10.map((c, i) => {
    const riskClass = c.riskScore > 0.55 ? "risk-high" : c.riskScore > 0.3 ? "risk-med" : "risk-low";
    const alertBadge = c.alertLevel !== "none" ? `<span class="badge badge-${c.alertLevel === "emergency" ? "red" : c.alertLevel === "warning" ? "orange" : "yellow"}">${c.alertLevel}</span>` : "—";
    return `<tr>
      <td>${i + 1}</td>
      <td><strong>${c.name}</strong></td>
      <td class="${riskClass}">${(c.riskScore * 100).toFixed(1)}%</td>
      <td>${alertBadge}</td>
      <td>${c.population.toLocaleString()}</td>
      <td>${(c.vulnerabilityScore * 100).toFixed(0)}%</td>
      <td>${c.hospitals.length}</td>
      <td>${c.hasDeclaration ? '<span class="badge badge-orange">YES</span>' : "—"}</td>
    </tr>`;
  }).join("")}
  </tbody>
</table>

<h2>Active Response Tasks (${activeTasks.length} total)</h2>
<table>
  <thead><tr><th>ID</th><th>Type</th><th>County</th><th>Priority</th><th>Status</th><th>Assigned To</th><th>Trigger</th></tr></thead>
  <tbody>
  ${activeTasks.sort((a, b) => b.priorityScore - a.priorityScore).map(t => {
    const statusBadge = t.status === "assigned" || t.status === "in_progress"
      ? `<span class="badge badge-green">${t.status}</span>`
      : `<span class="badge badge-orange">${t.status}</span>`;
    const resource = t.assignedResourceId ? state.resources[t.assignedResourceId] : null;
    return `<tr>
      <td>${t.id}</td>
      <td>${t.type.replace(/_/g, " ")}</td>
      <td>${t.targetName}</td>
      <td class="${t.priorityScore >= 70 ? "risk-high" : t.priorityScore >= 40 ? "risk-med" : ""}">${t.priorityScore}</td>
      <td>${statusBadge}</td>
      <td>${resource ? resource.label : '<span style="color:#cc0000">UNASSIGNED</span>'}</td>
      <td style="font-size:8pt;color:#555">${t.triggerReason.slice(0, 60)}${t.triggerReason.length > 60 ? "..." : ""}</td>
    </tr>`;
  }).join("")}
  </tbody>
</table>

<h2>Resource Deployment Status (${Object.keys(state.resources).length} total)</h2>
<table>
  <thead><tr><th>ID</th><th>Label</th><th>Type</th><th>Base</th><th>Status</th><th>Assigned Task</th></tr></thead>
  <tbody>
  ${Object.values(state.resources).sort((a, b) => a.status.localeCompare(b.status)).map(r => {
    const task = r.assignedTaskId ? state.tasks[r.assignedTaskId] : null;
    return `<tr>
      <td>${r.id}</td>
      <td>${r.label}</td>
      <td>${r.type.replace(/_/g, " ")}</td>
      <td>${r.baseName}</td>
      <td><span class="badge ${r.status === "available" ? "badge-green" : r.status === "deployed" ? "badge-orange" : "badge-red"}">${r.status}</span></td>
      <td style="font-size:8pt">${task ? `${task.id} — ${task.targetName}` : "—"}</td>
    </tr>`;
  }).join("")}
  </tbody>
</table>

<h2>Active NWS Alerts (${state.alerts.length})</h2>
${state.alerts.length === 0 ? "<p style='color:#555;font-size:9pt'>No active weather alerts for Georgia.</p>" : `
<table>
  <thead><tr><th>Event</th><th>Severity</th><th>Issued</th><th>Expires</th><th>Counties Affected</th></tr></thead>
  <tbody>
  ${state.alerts.slice(0, 20).map(a => `<tr>
    <td>${a.event}</td>
    <td>${a.severity}</td>
    <td style="font-size:8pt">${new Date(a.issuedAt).toLocaleString()}</td>
    <td style="font-size:8pt">${new Date(a.expiresAt).toLocaleString()}</td>
    <td style="font-size:8pt">${a.affectedCountyFips.length} zones</td>
  </tr>`).join("")}
  </tbody>
</table>`}

<div class="footer">
  AEGIS Critical Infrastructure Response Coordinator · Georgia Emergency Operations<br>
  Data: NWS api.weather.gov · OpenFEMA fema.gov/api/open · Census api.census.gov · HIFLD Hospitals (ARCGIS)<br>
  FOR OFFICIAL USE ONLY — Generated ${now.toISOString()}
</div>
</body>
</html>`;
}
