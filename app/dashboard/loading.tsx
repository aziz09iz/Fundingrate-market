import { PageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <PageSkeleton cards={3} rows={8} />;
}
