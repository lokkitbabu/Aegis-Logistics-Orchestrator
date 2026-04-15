/**
 * POST /api/aip
 *
 * Unified AIP endpoint. Priority:
 *   1. Foundry AIP Agent (if FOUNDRY_AIP_AGENT_RID configured)
 *      → AipAgents.Sessions.blockingContinue() — agent reasons over live Ontology
 *   2. Anthropic claude-sonnet (if ANTHROPIC_API_KEY configured)
 *      → Raw LLM with injected operational context
 *   3. Palantir AIP REST endpoint (if AIP_ENDPOINT + AIP_TOKEN configured)
 */
import { NextRequest, NextResponse } from "next/server";
import { getFoundryConfig } from "@/lib/foundry-client";

const SYSTEM = `You are an AI operations advisor embedded in AEGIS — a Critical Infrastructure Response Coordinator for Georgia emergency management (FEMA/National Guard).

You have access to live county-level data: NWS weather alerts, FEMA disaster declarations, Census vulnerability data (elderly %, no-vehicle households, poverty rate), and HIFLD hospital locations across all 159 Georgia counties.

Respond ONLY in raw JSON. No markdown. No preamble.

RESPONSE SCHEMAS:

Situation synthesis:
{"action":"situation_synthesis","message":"<2-3 sentences naming specific counties and quantified risk factors>"}

Action recommendations:
{"action":"recommend_actions","message":"<specific actionable steps with county names and resource types>"}

Explain decision:
{"action":"explain_decision","message":"<explain ranking citing specific data: alert type, declaration status, hospital count, vulnerability score>"}

Operator override (prioritize hospitals, focus coastal, reassign resources, etc.):
{"action":"apply_override","message":"<what changed and why>","weightOverrides":{"weatherSeverity":<0-1>,"femaDeclaration":<0-1>,"populationExposure":<0-1>,"vulnerability":<0-1>,"criticalFacility":<0-1>}}

Resource gap analysis:
{"action":"resource_analysis","message":"<coverage gaps, uncovered tasks, what resources are needed and where>"}

Rules:
- Always cite specific county names (e.g. Fulton, Chatham, Lowndes)
- Always reference specific data points (risk score %, alert type, hospital count)
- Weights must sum to approximately 1.0
- Never be generic — this is a real ops system with real data`;

export async function POST(req: NextRequest) {
  const { message, context, sessionRid } = await req.json();

  // ── Priority 1: Foundry AIP Agent ────────────────────────────────────────
  const foundryConfig = getFoundryConfig();
  if (foundryConfig?.aipAgentRid) {
    try {
      const res = await fetch(`${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/api/foundry/aip-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionRid, context }),
      });
      const data = await res.json();
      if (data.configured && data.message) return NextResponse.json(data);
    } catch {}
  }

  // ── Priority 2: Palantir AIP REST endpoint ────────────────────────────────
  const aipEndpoint = process.env.AIP_ENDPOINT;
  const aipToken    = process.env.AIP_TOKEN;
  if (aipEndpoint && aipToken) {
    try {
      const res = await fetch(aipEndpoint, {
        method: "POST",
        headers: { "Authorization": `Bearer ${aipToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ userInput: { message }, context: { systemState: context } }),
      });
      const data = await res.json();
      const text = (data?.response?.message ?? "{}").replace(/```json|```/g, "").trim();
      return NextResponse.json({ source: "palantir_aip", ...JSON.parse(text) });
    } catch {}
  }

  // ── Priority 3: Anthropic API ─────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ action: "situation_synthesis", message: "No AI backend configured. Set ANTHROPIC_API_KEY, AIP_TOKEN, or FOUNDRY_AIP_AGENT_RID.", source: "none" });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 600, system: SYSTEM,
        messages: [{ role: "user", content: `LIVE SYSTEM STATE:\n${JSON.stringify(context, null, 2)}\n\nOPERATOR: ${message}` }],
      }),
    });
    const data = await res.json();
    const text = (data?.content?.[0]?.text ?? "{}").replace(/```json|```/g, "").trim();
    return NextResponse.json({ source: "anthropic", ...JSON.parse(text) });
  } catch (e) {
    return NextResponse.json({ action: "situation_synthesis", message: `Error: ${e instanceof Error ? e.message : String(e)}`, source: "error" });
  }
}
