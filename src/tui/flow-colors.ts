import { italic } from "./render-utils.js";

export type FlowColorRole =
  | "flowName"
  | "modelName"
  | "stats"
  | "treeChars"
  | "prefixLabel"
  | "aimContent"
  | "actContent"
  | "msgContent"
  | "msgError";

export interface FlowColorConfig {
  flowName: { color: string; bold?: boolean; italic?: boolean };
  modelName: { color: string; bold?: boolean; italic?: boolean };
  stats: { color: string; bold?: boolean; italic?: boolean };
  treeChars: { color: string; bold?: boolean; italic?: boolean };
  prefixLabel: { color: string; bold?: boolean; italic?: boolean };
  aimContent: { color: string; bold?: boolean; italic?: boolean };
  actContent: { color: string; bold?: boolean; italic?: boolean };
  msgContent: { color: string; bold?: boolean; italic?: boolean };
  msgError: { color: string; bold?: boolean; italic?: boolean };
}

export type FlowTheme = { fg: (color: string, text: string) => string; bold: (s: string) => string };

export const DEFAULT_FLOW_COLORS: FlowColorConfig = {
  flowName: { color: "accent", bold: true },
  modelName: { color: "muted" },
  stats: { color: "muted" },
  treeChars: { color: "dim" },
  prefixLabel: { color: "muted" },
  aimContent: { color: "dim", italic: true },
  actContent: { color: "dim", italic: true },
  msgContent: { color: "dim", italic: true },
  msgError: { color: "muted", italic: true },
};

export function applyRole(
  role: FlowColorRole,
  text: string,
  theme: FlowTheme,
  config: FlowColorConfig = DEFAULT_FLOW_COLORS,
): string {
  const cfg = config[role];
  let result = theme.fg(cfg.color, text);
  if (cfg.bold) result = theme.bold(result);
  if (cfg.italic) result = italic(result);
  return result;
}
