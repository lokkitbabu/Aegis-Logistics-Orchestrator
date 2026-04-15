# AEGIS — Critical Infrastructure Response Coordinator

A county-level disaster operations platform for Georgia emergency management (FEMA/National Guard). Integrates live public hazard, disaster, demographic, and hospital data into an operational Foundry-style model, then uses AI to help emergency managers prioritize and assign response actions.

## What It Does

**Four live data sources, no mocks:**
- **NWS** `api.weather.gov/alerts/active?area=GA` — live weather alerts, auto-refreshed every 2 minutes
- **OpenFEMA** `fema.gov/api/open/v2/disasterDeclarations` — disaster declarations (5-year window)
- **Census ACS** `api.census.gov/data/2022/acs5` — population, elderly %, no-vehicle households, poverty rates for all 159 Georgia counties
- **HIFLD** `services1.arcgis.com/Hp6G80Pky0om7QvQ` — hospital locations and bed counts

**Operational decision engine:**
- Risk scoring: composite of weather severity, FEMA declaration status, population exposure, vulnerability, hospital density
- Auto task generation: 5 rule types (damage assessment, facility check, shelter support, resource staging, evacuation)
- Resource assignment: priority-weighted greedy matching with type compatibility
- Shortfall analysis: identifies uncovered high-priority tasks and what resource types are needed

**AIP Copilot:**
- Situation synthesis — named counties, quantified risk factors
- Action recommendations — specific crew/generator/shelter deployments
- Explain decisions — cite data (alert type, declaration, hospital count, vulnerability %)
- Operator overrides — natural language → weight adjustments → live recompute

**Foundry Platform SDK:**
- `@osdk/foundry` v2.59.0 installed — `OntologyObjectsV2.list()`, `Actions.apply()`, `AipAgents.Sessions.blockingContinue()`
- When `FOUNDRY_STACK` is configured, task approvals/cancellations write back to the Foundry Ontology
- Falls back gracefully to in-memory state when running standalone

## Getting Started

```bash
git clone https://github.com/lokkitbabu/Aegis-Logistics-Orchestrator
cd Aegis-Logistics-Orchestrator
npm install
cp .env.local.example .env.local   # fill in API keys
npm run dev
# → http://localhost:3000
```

## Environment Variables

```bash
# Required for AI copilot (choose one):
ANTHROPIC_API_KEY=sk-ant-...        # Claude via Anthropic API
AIP_TOKEN=...                        # Palantir AIP REST endpoint token
AIP_ENDPOINT=https://...             # Palantir AIP REST endpoint URL

# Optional — Foundry Platform SDK (real Ontology writeback):
FOUNDRY_STACK=https://your-stack.palantirfoundry.com
FOUNDRY_CLIENT_ID=...                # OAuth2 client ID from Developer Console
FOUNDRY_CLIENT_SECRET=...            # OAuth2 client secret
FOUNDRY_ONTOLOGY_RID=ri.ontology.main.ontology.xxxxx
FOUNDRY_AIP_AGENT_RID=ri.aip-agents.main.agent.xxxxx   # optional
```

## Foundry Integration

### Ontology Object Types
| Object Type | Properties | Backed By |
|-------------|-----------|-----------|
| `county-region` | fips, name, riskScore, alertLevel, vulnerabilityScore, population | Census ACS + NWS + FEMA |
| `hazard-event` | eventId, type, severity, issuedAt, expiresAt, affectedCountyFips | NWS Alerts |
| `critical-facility` | name, countyFips, beds, type, lat, lng | HIFLD |
| `response-task` | taskId, type, priorityScore, status, assignedResourceId | Generated |
| `response-resource` | resourceId, type, label, status, assignedTaskId | Configured |

### Action Types
| Action | Parameters | Effect |
|--------|-----------|--------|
| `approve-response-task` | `taskId` | → `in_progress`, triggers assignment |
| `cancel-response-task` | `taskId` | → `cancelled`, releases resource |
| `assign-resource-to-task` | `taskId`, `resourceId` | Deploys resource |
| `apply-scoring-weights` | `weatherSeverity`, etc. | Recomputes all risk scores |

### SDK Usage
```typescript
import { Ontologies, AipAgents } from "@osdk/foundry";
import { createPlatformClient } from "@osdk/client";
import { createConfidentialOauthClient } from "@osdk/oauth";

const auth = createConfidentialOauthClient(clientId, secret, stack);
const client = createPlatformClient(stack, auth);

// Read county risk data
const counties = await Ontologies.OntologyObjectsV2.list(
  client, ontologyRid, "county-region",
  { select: ["countyFips", "riskScore", "alertLevel"],
    orderBy: { fields: [{ field: "riskScore", direction: "DESC" }] } }
);

// Apply task approval action
await Ontologies.Actions.apply(client, ontologyRid,
  "approve-response-task", { parameters: { taskId: "T001" } }
);

// AIP Agent session
const session = await AipAgents.Sessions.create(client, agentRid, {});
const response = await AipAgents.Sessions.blockingContinue(
  client, agentRid, session.rid,
  { userInput: { text: "Synthesize current situation" }, parameterInputs: {} }
);
```

## Architecture

```
NWS Alerts ──────┐
OpenFEMA ────────┤ /api/nws, /api/fema,     ┌─ Risk Scoring Engine
Census ACS ──────┤ /api/census, /api/hospitals├─ Task Generation Rules  → SystemState
HIFLD Hospitals ─┘                           └─ Assignment Planner
                                                        │
                              Foundry Platform SDK ─────┤ (optional writeback)
                              OntologyObjectsV2.list()   │
                              Actions.apply()            │
                              AipAgents.Sessions.blockingContinue()
                                                        │
                         AIP Copilot → /api/aip ────────┤
                         (Foundry AIP Agent priority)    │
                                                        ▼
                                              Operator Dashboard
                                         County Choropleth Map
                                         Task Queue + Approvals
                                         Resource Deployment
                                         Incident Report Export
```

## Demo Scenarios

Four pre-built simulation scenarios (no live alerts needed):
- **Coastal Flooding** — Chatham, Bryan, Glynn, Camden (storm surge)
- **Tornado Outbreak** — Fulton, DeKalb, Clayton (metro Atlanta)
- **Inland Flooding** — Lowndes, Thomas, Brooks (south Georgia)
- **Ice Storm** — Cherokee, Pickens, Gilmer (north Georgia mountains)

Click any scenario in the left panel to inject realistic NWS-style alerts and watch the system recompute risk scores, generate tasks, and assign resources.

## Report Export

Click **⬇ REPORT** in the top bar to download a structured HTML incident report including:
- Top 10 counties by risk score
- All active response tasks with assignments
- Resource deployment status
- Active NWS alerts summary
- Resource shortfall analysis
