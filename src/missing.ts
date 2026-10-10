export const MISSING = "__MISSING__";

export const dedicatedSummaryRatio = 0.25;
export const maxTokenCountPerSummary = 5_000;
export const minContextWindow =
  (maxTokenCountPerSummary / dedicatedSummaryRatio) * 2;
