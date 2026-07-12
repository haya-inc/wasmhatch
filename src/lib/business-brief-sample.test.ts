import { describe, expect, it } from "vitest";
import { BUSINESS_BRIEF_SAMPLE, businessBriefSamplePlan } from "./business-brief-sample";
import { validateWorkspaceArtifactPlan } from "./workspace-artifact-plan";

describe("business brief sample", () => {
  it("defines one bounded non-tabular Markdown workflow", () => {
    const plan = validateWorkspaceArtifactPlan(businessBriefSamplePlan());

    expect(BUSINESS_BRIEF_SAMPLE.inputPath).toBe("inputs/weekly-operations-brief.md");
    expect(plan.outputPath).toBe("outputs/weekly-decision-brief.md");
    expect(plan.outputMediaType).toBe("text/markdown");
    expect(plan.inputFiles).toBe(1);
    expect(plan.script).toContain('fs.readText("/inputs/workspace/inputs/weekly-operations-brief.md")');
    expect(plan.script).toContain('fs.writeText("/outputs/result.md", output)');
    expect(plan.script).not.toContain("fetch");
  });
});
