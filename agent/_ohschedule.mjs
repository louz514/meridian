import { GatewayClient } from "@openhermit/sdk";
const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });

const prompt =
  `Run your regular Meridian check-in as project manager. First pull the live data: GET https://meridian402-api-production.up.railway.app/api/agent-thoughts and GET https://meridian402-api-production.up.railway.app/api/opportunities, and read the current state from what comes back. Then do three things, briefly: 1) name the single thing most worth attention right now and why. 2) if something is genuinely worth saying publicly, write a short scoped brief for the copywriter and have one draft X post ready (do NOT post it). 3) flag anything the trader or researcher should dig into. Keep it short and grounded. Never invent a number. Take no irreversible or outward-facing action without a human. No em dashes.`;

if (prompt.includes("—")) { console.log("EM DASH in prompt, aborting"); process.exit(1); }

const sched = await gw.createSchedule("merd", { type: "cron", prompt, cronExpression: "0 14,21 * * *" });
console.log("✓ created schedule:", JSON.stringify(sched).slice(0, 260));

const all = await gw.listSchedules();
const list = Array.isArray(all) ? all : all?.schedules ?? [];
console.log(`\nschedules now (${list.length}):`);
for (const s of list) console.log(`  ${s.id ?? "?"}  agent=${s.agentId ?? "?"}  ${s.cronExpression ?? s.type}`);
