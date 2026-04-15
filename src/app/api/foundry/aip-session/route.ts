/**
 * POST /api/foundry/aip-session
 *
 * Drives an AIP Agent session via the official @osdk/foundry SDK:
 *   AipAgents.Sessions.create(client, agentRid, {})
 *   AipAgents.Sessions.blockingContinue(client, agentRid, sessionRid, {
 *     userInput: { text: string },
 *     parameterInputs: {}
 *   })
 *
 * The AIP Agent on the Foundry stack has native access to the Ontology —
 * CountyRegion, HazardEvent, ResponseTask, CriticalFacility objects —
 * without requiring us to inject context into the prompt.
 * It also has access to Foundry Functions for scoring and assignment logic.
 */
import { NextRequest, NextResponse } from "next/server";
import { getFoundryConfig } from "@/lib/foundry-client";

export async function POST(req: NextRequest) {
  const config = getFoundryConfig();
  if (!config?.aipAgentRid) {
    return NextResponse.json({ configured: false });
  }

  const { message, sessionRid: existingSessionRid, context } = await req.json();
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

  try {
    const { createFoundryClient } = await import("@/lib/foundry-client");
    const { client } = await createFoundryClient();
    const { AipAgents } = await import("@osdk/foundry");

    // Step 1: Create a new session if none exists
    // CreateSessionRequest only accepts optional agentVersion
    let sessionRid = existingSessionRid;
    if (!sessionRid) {
      const session = await AipAgents.Sessions.create(
        client,
        config.aipAgentRid,
        {}, // CreateSessionRequest — no required fields
        { preview: true }
      );
      sessionRid = session.rid;

      // Optionally title the session for traceability
      await AipAgents.Sessions.updateTitle(
        client,
        config.aipAgentRid,
        sessionRid,
        { title: `AEGIS Ops — ${new Date().toISOString()}` },
        { preview: true }
      ).catch(() => {}); // non-critical
    }

    // Step 2: Continue session with operator message
    // The agent receives the message and queries the Ontology autonomously.
    // We can also pass ObjectContext or FunctionRetrievedContext via contextsOverride
    // to explicitly ground the agent in specific objects.
    const response = await AipAgents.Sessions.blockingContinue(
      client,
      config.aipAgentRid,
      sessionRid,
      {
        userInput: { text: message },
        parameterInputs: {}, // Required field — empty for unparameterized agents
        // Optional: pass top-risk counties as ObjectContext for explicit grounding
        // contextsOverride: countyRids.map(rid => ({
        //   type: "objectContext",
        //   objectRid: rid,
        // })),
      },
      { preview: true }
    );

    // Extract response text from SessionExchangeResult
    const result = response as any;
    const responseText =
      result?.response?.message?.value ??
      result?.exchanges?.[0]?.response?.message?.value ??
      "No response from AIP Agent.";

    return NextResponse.json({
      configured: true,
      source: "foundry_aip_agent",
      sessionRid,
      message: responseText,
      action: inferAIPAction(responseText),
    });
  } catch (e) {
    return NextResponse.json({
      configured: true,
      error: String(e),
      message: `Foundry AIP Agent error: ${e instanceof Error ? e.message : String(e)}`,
    }, { status: 500 });
  }
}

function inferAIPAction(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("weight") || t.includes("prioritiz")) return "apply_override";
  if (t.includes("recommend") || t.includes("deploy") || t.includes("assign")) return "recommend_actions";
  if (t.includes("situation") || t.includes("summary") || t.includes("status")) return "situation_synthesis";
  if (t.includes("resource") || t.includes("shortfall") || t.includes("gap")) return "resource_analysis";
  return "explain_decision";
}
