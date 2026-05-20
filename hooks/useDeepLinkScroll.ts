import { RefObject, useEffect } from "react";

/**
 * Scroll a panel-local item into view when the URL targets this section.
 * Example: ?tab=integrations&integration=gmail
 */
export function useDeepLinkScroll(
  tabParamValue: string,
  itemParamName: string,
  containerRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    const itemId = params.get(itemParamName);
    if (tab !== tabParamValue || !itemId) return;

    const root = containerRef.current;
    if (!root) return;

    const target = root.querySelector<HTMLElement>(`[data-deep-link-id="${CSS.escape(itemId)}"]`);
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [containerRef, itemParamName, tabParamValue]);
}
