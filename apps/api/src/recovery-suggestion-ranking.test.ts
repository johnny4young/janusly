import { describe, expect, it } from "vitest";

import { rankRecoverySuggestions } from "./recovery-suggestion-ranking";

describe("rankRecoverySuggestions", () => {
  it("orders a copy by descending finite confidence", () => {
    const original = [
      { id: "medium", confidence: 0.5 },
      { id: "high", confidence: 0.9 },
      { id: "low", confidence: 0.1 },
    ];

    expect(rankRecoverySuggestions(original).map((item) => item.id)).toEqual([
      "high",
      "medium",
      "low",
    ]);
    expect(original.map((item) => item.id)).toEqual([
      "medium",
      "high",
      "low",
    ]);
  });

  it("preserves provider order for ties and treats invalid values as zero", () => {
    const suggestions = [
      { id: "first", confidence: 0.4 },
      { id: "second", confidence: 0.4 },
      { id: "missing" },
      { id: "nan", confidence: Number.NaN },
    ];

    expect(rankRecoverySuggestions(suggestions).map((item) => item.id)).toEqual([
      "first",
      "second",
      "missing",
      "nan",
    ]);
  });
});
