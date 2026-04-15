/**
 * POST /api/foundry/actions
 * Body: { actionType: string, parameters: Record<string, unknown> }
 *
 * Applies an Ontology Action via Foundry Platform SDK.
 *
 * SDK call: Ontologies.Actions.apply(client, ontologyRid, actionType, {
 *   parameters: { [parameterId]: value },
 *   options: { returnEdits: "ALL" }
 * })
 *
 * Action types defined in Foundry (match the API names in Action Types panel):
 *   create-response-task     → creates ResponseTask, links to CountyRegion
 *   assign-resource-to-task  → sets ResponseTask.assignedResourceId, ResponseResource.status
 *   update-task-status       → transitions task status
 *   approve-response-task    → approve + trigger assignment workflow
 *   cancel-response-task     → cancel + release resource
 *   apply-scoring-weights    → updates WeightConfig object used by scoring Functions
 *
 * Foundry enforces: parameter types, validation rules, and data lineage.
 * Every action is audited in Workflow Lineage.
 */
import { NextRequest, NextResponse } from "next/server";
import { getFoundryConfig } from "@/lib/foundry-client";

export async function POST(req: NextRequest) {
  const config = getFoundryConfig();
  if (!config) return NextResponse.json({ configured: false });

  const { actionType, parameters } = await req.json();
  if (!actionType) return NextResponse.json({ error: "actionType required" }, { status: 400 });

  try {
    const { createFoundryClient } = await import("@/lib/foundry-client");
    const { client } = await createFoundryClient();
    const { Ontologies: { Actions } } = await import("@osdk/foundry");

    const result = await Actions.apply(
      client,
      config.ontologyRid,
      actionType,
      {
        parameters: parameters ?? {},
        options: { returnEdits: "ALL" },
      }
    );

    return NextResponse.json({
      configured: true,
      success: true,
      actionType,
      edits: (result as any).edits ?? null,
    });
  } catch (e) {
    return NextResponse.json({
      configured: true,
      success: false,
      error: String(e),
    }, { status: 500 });
  }
}
