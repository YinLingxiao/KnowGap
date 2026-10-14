import { useId } from "react";

/** 品牌标识：一块完整的知识 + 一块缺口，缺口处的亮点代表被发现的「知隙」 */
export function LogoMark({ size = 32 }: { size?: number }) {
  const gradientId = `kg-logo-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6d66f6" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      <rect x="8" y="8" width="6.5" height="16" rx="2" fill="#ffffff" />
      <rect x="17.5" y="8" width="6.5" height="8.5" rx="2" fill="#ffffff" fillOpacity="0.55" />
      <circle cx="20.75" cy="21.25" r="2.6" fill="#fbbf24" />
    </svg>
  );
}
