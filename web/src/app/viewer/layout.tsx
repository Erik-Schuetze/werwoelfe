import type { Metadata } from "next";

/**
 * The audience's copy of the root metadata.
 *
 * A layout's title replaces the parent's rather than inheriting it, so this segment stops
 * advertising itself as the private operator console (see `app/layout.tsx`) without changing
 * what the operator's own pages are called.
 */
export const metadata: Metadata = {
  title: "Millers Hollow — Public viewer",
  description: "Watch Werewolves LLM games, live or from the archive.",
};

export default function ViewerLayout({ children }: LayoutProps<"/viewer">) {
  return children;
}
