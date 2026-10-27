import type { Metadata } from "next";
import OpenHandoff from "./open-handoff";

export const metadata: Metadata = {
  title: "BRNT — opening the original site with its cookies",
  robots: { index: false, follow: false },
};

export default async function OpenResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <OpenHandoff resultId={id} />;
}
