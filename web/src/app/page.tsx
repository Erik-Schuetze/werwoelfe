import { connection } from "next/server";

import { Dashboard } from "@/components/dashboard";
import { listGames } from "@/lib/server/db";

export const instant = false;

export default async function Home() {
  await connection();
  return <Dashboard initialGames={listGames()} />;
}
