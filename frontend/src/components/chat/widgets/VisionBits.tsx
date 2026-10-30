"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { useI18n } from "@/components/LanguageProvider";
import { loadImageUrl } from "@/lib/api/vision-client";
import { EFFORT_LABEL, type Route } from "./visionData";
import styles from "./VisionWidgets.module.css";

/** Loads an uploaded image through the authenticated endpoint. Pass null to load nothing. */
export function useImageUrl(imageId: string | null): { url: string; failed: boolean } {
  const [state, setState] = useState<{ id: string | null; url: string; failed: boolean }>({ id: null, url: "", failed: false });
  useEffect(() => {
    if (!imageId) return;
    let alive = true;
    loadImageUrl(imageId).then(
      (url) => {
        if (alive) setState({ id: imageId, url, failed: false });
      },
      () => {
        if (alive) setState({ id: imageId, url: "", failed: true });
      },
    );
    return () => {
      alive = false;
    };
  }, [imageId]);
  return state.id === imageId && imageId ? { url: state.url, failed: state.failed } : { url: "", failed: false };
}

/** Shows which thinking effort the router picked for this turn, and why. */
export function RouteBadge({ route }: { route: Route | null }) {
  const { tx } = useI18n();
  if (!route) return null;
  const how = route.source === "user" ? tx("按你的思考深度设置") : tx("按题目复杂度自动选择");
  return (
    <span className={styles.routeBadge} title={tx("{reason}（{how}）", { reason: route.reason, how })}>
      <Gauge size={11} aria-hidden />
      <span>{tx("思考 · {effort}", { effort: tx(EFFORT_LABEL[route.effort]) })}</span>
      <span className="sr-only">{tx("，{reason}，{how}", { reason: route.reason, how })}</span>
    </span>
  );
}
