import { notFound } from "next/navigation";
import { connection } from "next/server";

import { Dashboard } from "@/components/dashboard";
import { isViewerMode } from "@/lib/mode";
import { listGames } from "@/lib/server/db";

export const instant = false;

export default async function Home() {
  await connection();
  // The proxy already 404s this path in viewer mode; this guard is the second layer, so the
  // operator's own console cannot render on the public hostname if the gate is ever bypassed.
  if (isViewerMode()) {
    notFound();
  }
  return <Dashboard initialGames={listGames()} mode="operator" />;
}
