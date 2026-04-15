import { NextResponse } from "next/server";
import { getFoundryConfig } from "@/lib/foundry-client";
import { readFileSync } from "fs";
import { resolve } from "path";

export async function GET() {
  const config = getFoundryConfig();
  let sdkVersion = "unknown";
  try { sdkVersion = JSON.parse(readFileSync(resolve("node_modules/@osdk/foundry/package.json"),"utf8")).version; } catch {}

  if (!config) {
    return NextResponse.json({
      configured: false, mode:"standalone",
      message:"Running in standalone mode. Connect to a Foundry stack by setting FOUNDRY_STACK, FOUNDRY_CLIENT_ID, FOUNDRY_CLIENT_SECRET, FOUNDRY_ONTOLOGY_RID.",
      sdkVersion,
      sdkPackages:["@osdk/foundry","@osdk/client","@osdk/oauth"],
      capabilities:{ ontologyRead:false, ontologyWrite:false, aipAgent:false, datasets:false },
      ontologyObjectTypes:["county-region","hazard-event","response-task","response-resource","critical-facility"],
      actionTypes:["create-response-task","assign-resource-to-task","update-task-status","approve-response-task","cancel-response-task","apply-scoring-weights"],
    });
  }

  let connected=false, error:string|null=null;
  try { const { createFoundryClient } = await import("@/lib/foundry-client"); await createFoundryClient(); connected=true; }
  catch(e){ error=String(e); }

  return NextResponse.json({
    configured:true, connected, mode:connected?"foundry":"foundry_error",
    stack:config.stack, ontologyRid:config.ontologyRid,
    aipAgentConfigured:!!config.aipAgentRid, error, sdkVersion,
    sdkPackages:["@osdk/foundry","@osdk/client","@osdk/oauth"],
    capabilities:{ ontologyRead:connected, ontologyWrite:connected, aipAgent:connected&&!!config.aipAgentRid, datasets:connected },
    ontologyObjectTypes:["county-region","hazard-event","response-task","response-resource","critical-facility"],
    actionTypes:["create-response-task","assign-resource-to-task","update-task-status","approve-response-task","cancel-response-task","apply-scoring-weights"],
  });
}
