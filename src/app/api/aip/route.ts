import { NextRequest, NextResponse } from "next/server";

const SYSTEM = `You are an AI mission advisor in a contested-environment logistics coordination system.
You manage autonomous delivery assets (drones, ground vehicles) resupplying forward operating bases and outposts.

Respond ONLY in raw JSON. No preamble. No markdown.

For CONSTRAINT updates: {"action":"update_constraints","weights":{"travel":<0-5>,"risk":<0-5>,"battery":<0-5>,"lateness":<0-5>,"priority":<0-5>,"cargo":<0-5>},"explanation":"<one sentence>"}
For ASSET OVERRIDE: {"action":"override","taskId":"<id>","forceAssetType":"<drone|ground|null>","forceAssetId":"<id|null>","explanation":"<one sentence>"}
For MISSION SUGGESTION: {"action":"suggest_mission","suggestedMission":{"sourceNodeId":"<id>","destNodeId":"<id>","cargoType":"<medevac|ammo|food|equipment|fuel>","quantity":<number>,"priority":<1-5>},"explanation":"<one sentence>"}
For EXPLANATION: {"action":"explain","explanation":"<2-3 sentences grounded in the data>"}

Node IDs available: N_FOB_ALPHA, N_DEPOT_B, N_OUT_C, N_OUT_D, N_LZ_ECHO
Cargo types: medevac, ammo, food, equipment, fuel`;

export async function POST(req: NextRequest) {
  const { message, context } = await req.json();
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AIP_TOKEN;
  const endpoint = process.env.AIP_ENDPOINT || "https://api.anthropic.com/v1/messages";
  const usePalantir = !!process.env.AIP_ENDPOINT;

  if (!apiKey) {
    return NextResponse.json({ action:"explain", explanation:"AI layer not configured. Set ANTHROPIC_API_KEY." });
  }
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
        model: "claude-sonnet-4-20250514", max_tokens: 512, system: SYSTEM,
        messages: [{ role:"user", content:`SYSTEM STATE:\n${JSON.stringify(context,null,2)}\n\nOPERATOR: ${message}` }],
      };
    }
    const res = await fetch(endpoint, { method:"POST", headers, body:JSON.stringify(body) });
    const data = await res.json();
    const text = (usePalantir ? data?.response?.message : data?.content?.[0]?.text) ?? "{}";
    return NextResponse.json(JSON.parse(text.replace(/```json|```/g,"").trim()));
  } catch(e) {
    return NextResponse.json({ action:"explain", explanation:`AIP error: ${e instanceof Error?e.message:String(e)}` });
  }
}
