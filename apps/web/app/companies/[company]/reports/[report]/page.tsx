import type { Metadata } from "next";
import {
  listResearchCompanyIds,
  listResearchSnapshots,
  loadResearchSnapshot,
} from "@airesearch/research-schema";
import { ReportView } from "@airesearch/research-ui";
import path from "node:path";

export function generateStaticParams() {
  return listResearchCompanyIds(repoRoot()).flatMap((company) =>
    listResearchSnapshots(repoRoot(), company).map(({ data }) => ({
      company,
      report: data.snapshot.id,
    })),
  );
}

type ReportPageProps = {
  params: Promise<{ company: string; report: string }>;
};

function repoRoot() {
  return path.resolve(process.cwd(), "../..");
}

export async function generateMetadata({
  params,
}: ReportPageProps): Promise<Metadata> {
  const route = await params;
  const loaded = loadResearchSnapshot(repoRoot(), route.company, route.report);

  return {
    title: `${loaded.data.company.name}研究报告`,
    other: {
      "research-snapshot-sha256": loaded.sha256,
      "research-publication-version": "0.1.0",
    },
  };
}

export default async function ReportPage({ params }: ReportPageProps) {
  const route = await params;
  const loaded = loadResearchSnapshot(repoRoot(), route.company, route.report);

  return (
    <>
      <link rel="stylesheet" href="../../../assets/research.css" />
      <script defer src="../../../assets/research.js" />
      <ReportView snapshot={loaded.data} />
    </>
  );
}
