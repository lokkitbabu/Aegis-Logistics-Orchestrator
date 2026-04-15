/**
 * GET /api/foundry/objects?type=county-region&select=countyFips,name,riskScore&pageSize=200
 *
 * Reads Ontology objects via Foundry Platform SDK.
 *
 * SDK call: Ontologies.OntologyObjectsV2.list(client, ontologyRid, objectType, {
 *   select: [...propertyNames],  // required
 *   pageSize: number,
 *   orderBy: { fields: [{ field, direction }] },
 * })
 *
 * On a real Foundry stack this returns live objects backed by synchronized
 * NWS/FEMA/Census datasets. Scoring, vulnerability, and risk properties are
 * computed by Foundry Transforms running on schedule.
 */
import { NextRequest, NextResponse } from "next/server";
import { getFoundryConfig } from "@/lib/foundry-client";

export async function GET(req: NextRequest) {
  const config = getFoundryConfig();
  if (!config) {
    return NextResponse.json({ configured: false, objects: [] });
  }

  const params   = req.nextUrl.searchParams;
  const type     = params.get("type") ?? "county-region";
  const pageSize = parseInt(params.get("pageSize") ?? "200");
  const select   = (params.get("select") ?? "").split(",").filter(Boolean);
  const orderBy  = params.get("orderBy"); // e.g. "riskScore:DESC"

  // Default select fields per object type
  const defaultSelect: Record<string, string[]> = {
    "county-region":    ["countyFips","name","state","population","vulnerabilityScore","riskScore","alertLevel","declarationStatus","impactedPopulationEstimate"],
    "hazard-event":     ["eventId","eventType","severity","issuedAt","expiresAt","affectedCountyFips"],
    "response-task":    ["taskId","taskType","title","targetCountyFips","priorityScore","status","assignedResourceId","triggerReason","deadlineHours","createdAt"],
    "response-resource":["resourceId","resourceType","label","baseFips","baseName","status","assignedTaskId","assignedFips","latitude","longitude"],
    "critical-facility":["facilityId","name","countyFips","facilityType","beds","latitude","longitude"],
  };

  const selectFields = select.length > 0 ? select : (defaultSelect[type] ?? []);

  try {
    const { createFoundryClient } = await import("@/lib/foundry-client");
    const { client } = await createFoundryClient();
    const { Ontologies: { OntologyObjectsV2 } } = await import("@osdk/foundry");

    const queryParams: Record<string, unknown> = {
      select: selectFields,
      pageSize,
    };

    if (orderBy) {
      const [field, dir] = orderBy.split(":");
      queryParams.orderBy = { fields: [{ field, direction: dir ?? "ASC" }] };
    }

    const result = await OntologyObjectsV2.list(
      client,
      config.ontologyRid,
      type,
      queryParams as any
    );

    return NextResponse.json({
      configured: true,
      type,
      objects: result.data ?? [],
      nextPageToken: result.nextPageToken ?? null,
      count: result.data?.length ?? 0,
    });
  } catch (e) {
    return NextResponse.json({
      configured: true,
      error: String(e),
      objects: [],
    }, { status: 500 });
  }
}
