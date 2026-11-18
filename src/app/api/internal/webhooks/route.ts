import { NextResponse } from "next/server";

import { retryDueDeliveries } from "@/lib/api/webhooks";
import { identifyRetentionCaller } from "@/lib/retention-job";

// Retries webhook deliveries that failed. Called by the daily cron job in
// vercel.json, or by any scheduler that can send the job secret.
async function handle(request: Request) {
  if (identifyRetentionCaller(request.headers.get("authorization")) === "denied") {
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json(await retryDueDeliveries());
}

export const GET = handle;
export const POST = handle;
