import { PageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <PageSkeleton cards={4} rows={6} filters={false} />;
}
