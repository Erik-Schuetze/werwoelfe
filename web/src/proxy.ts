/**
 * The viewer's first line of defence: a request that is not on the audience allow-list never
 * reaches a route handler, a page or a server action.
 *
 * One image serves both deployments, so this file runs in operator mode too — where it is a no-op
 * and the console behaves exactly as before. Only in viewer mode does it 404 everything outside
 * `GET /viewer` and `GET /api/viewer/*`, which is what keeps the operator's unauthenticated
 * mutations off the public hostname. It is a gate, not the whole defence: the `notFound()` guards
 * in the pages and the read-only `/api/public/*` endpoint are the layers behind it.
 *
 * The decision itself lives in `./lib/proxy-policy.ts` so it can be unit-tested without a server.
 * This file is expected to run on the Node.js runtime (Next 16 does not allow configuring it), so
 * `process.env` is read live on every request — see `deploymentMode()`.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { deploymentMode } from "@/lib/mode";
import { decideRequest } from "@/lib/proxy-policy";

export function proxy(request: NextRequest): NextResponse {
  const decision = decideRequest(
    deploymentMode(),
    request.nextUrl.pathname,
    request.method,
  );
  if (!decision.allow) {
    return new NextResponse(null, { status: decision.status });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
