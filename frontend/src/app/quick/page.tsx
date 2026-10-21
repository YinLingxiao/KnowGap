import type { Metadata } from "next";
import { QuickAsk } from "@/components/quick/QuickAsk";

export const metadata: Metadata = { title: "快问 · 知隙 KnowGap" };

export default function QuickPage() {
  return <QuickAsk />;
}
