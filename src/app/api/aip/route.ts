import { NextRequest, NextResponse } from "next/server";

const SYSTEM = `You are an AI advisor embedded in a Critical Infrastructure Response Coordinator for Georgia emergency management (FEMA/National Guard operations).

You analyze real county-level data: NWS weather alerts, FEMA disaster declarations, Census vulnerability data (elderly, no-vehicle, poverty), and hospital locations.

Respond ONLY in raw JSON. No markdown. No preamble.

For SITUATION SYNTHESIS: {"action":"situation_synthesis","message":"<2-3 sentence operational summary naming specific counties and why>"}

For RECOMMEND ACTIONS: {"action":"recommend_actions","message":"<specific actionable recommendations with county names and resource types>"}

For EXPLAIN DECISION: {"action":"explain_decision","message":"<explain why a specific county ranks high or task was created, citing data points>"}

For OPERATOR OVERRIDE (e.g. 'prioritize hospitals', 'focus on coastal counties'):
{"action":"apply_override","message":"<what changed and why>","weightOverrides":{"weatherSeverity":<0-1>,"femaDeclaration":<0-1>,"populationExposure":<0-1>,"vulnerability":<0-1>,"criticalFacility":<0-1>}}

For RESOURCE ANALYSIS: {"action":"resource_analysis","message":"<analysis of coverage gaps, shortfalls, and recommendations>"}

Always cite specific county names, risk scores, and data sources. Never be generic.`;

export async function POST(req: NextRequest) {
  const { message, context } = await req.json();
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AIP_TOKEN;
  const endpoint = process.env.AIP_ENDPOINT || "https://api.anthropic.com/v1/messages";
  const usePalantir = !!process.env.AIP_ENDPOINT;

  if (!apiKey) return NextResponse.json({ action:"situation_synthesis", message:"AIP not configured. Set ANTHROPIC_API_KEY or AIP_TOKEN." });

  try {
    const headers: Record<string,string> = {"Content-Type":"application/json"};
    let body: object;
    if (usePalantir) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      body = { userInput:{message}, context:{systemState:context} };
    } else {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model:"claude-sonnet-4-20250514", max_tokens:600, system:SYSTEM,
        messages:[{role:"user",content:`LIVE SYSTEM STATE:\n${JSON.stringify(context,null,2)}\n\nOPERATOR: ${message}`}],
      };
    }
    const res = await fetch(endpoint,{method:"POST",headers,body:JSON.stringify(body)});
    const data = await res.json();
    const text = (usePalantir?data?.response?.message:data?.content?.[0]?.text)??"{}";
    return NextResponse.json(JSON.parse(text.replace(/```json|```/g,"").trim()));
  } catch(e) {
    return NextResponse.json({action:"situation_synthesis",message:`AIP error: ${e instanceof Error?e.message:String(e)}`});
  }
}
