import type { PanelImperativeHandle } from "react-resizable-panels";

/**
 * Imperative panel changes and ResizeObserver notifications do not arrive in
 * the same turn. Keep the compact renderer in step with the action itself;
 * onResize still covers drag and persisted-layout changes.
 */
export function togglePanel(
  panel: PanelImperativeHandle | null,
  setCollapsed: (collapsed: boolean) => void,
): void {
  if (!panel) return;
  const expand = panel.isCollapsed();
  if (expand) panel.expand();
  else panel.collapse();
  setCollapsed(!expand);
}
