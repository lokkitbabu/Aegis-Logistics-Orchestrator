import { NextRequest, NextResponse } from "next/server";

const SYSTEM = `You are an AI mission advisor embedded in a contested-environment logistics coordination system.
You help operators control autonomous delivery assets (drones and ground vehicles).
You have access to real-time system state.

Respond ONLY in raw JSON. No preamble. No markdown fences.

For CONSTRAINT updates (operator sets intent), return:
{"action":"update_constraints","weights":{"travel":<0-5>,"risk":<0-5>,"battery":<0-5>,"lateness":<0-5>,"priority":<0-5>},"explanation":"<one sentence>"}

For OVERRIDE commands (force specific asset/task), return:
{"action":"override","taskId":"<id or null>","forceAssetType":"<drone|ground|null>","forceAssetId":"<id or null>","explanation":"<one sentence>"}

For EXPLANATION or anything else, return:
{"action":"explain","explanation":"<2-3 sentences grounded in the data>"}`;

export async function POST(req: NextRequest) {
  const { message, context } = await req.json();

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AIP_TOKEN;
  const endpoint = process.env.AIP_ENDPOINT || "https://api.anthropic.com/v1/messages";
  const usePalantir = !!process.env.AIP_ENDPOINT;

  if (!apiKey) {
    return NextResponse.json({
      action: "explain",
      explanation: "AI layer not configured. Set ANTHROPIC_API_KEY or AIP_TOKEN.",
    });
  }

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    let body: object;
    if (usePalantir) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      body = { userInput: { message }, context: { systemState: context } };
    } else {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: `SYSTEM STATE:\n${JSON.stringify(context, null, 2)}\n\nOPERATOR: ${message}`,
        }],
      };
    }

    const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json();

    let text: string;
    if (usePalantir) {
      text = data?.response?.message ?? "{}";
    } else {
      text = data?.content?.[0]?.text ?? "{}";
    }

    text = text.replace(/```json|```/g, "").trim();
    return NextResponse.json(JSON.parse(text));
  } catch (e) {
    return NextResponse.json({
      action: "explain",
      explanation: `AIP error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
