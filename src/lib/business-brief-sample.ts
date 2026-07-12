import type { WorkspaceArtifactPlan } from "./workspace-artifact-plan";

export const BUSINESS_BRIEF_SAMPLE = Object.freeze({
  inputPath: "inputs/weekly-operations-brief.md",
  outputPath: "outputs/weekly-decision-brief.md",
  task: "Turn this weekly operations brief into a concise decision report with progress, decisions, and risks.",
  content: `# Weekly operations brief

## Progress
- Customer onboarding is on schedule for Friday.
- Support backlog fell from 18 items to 9.

## Decisions needed
- Decide whether to extend the vendor migration by two days.

## Risks
- The vendor response is late and may affect Monday's handoff.
`
});

export function businessBriefSamplePlan(): WorkspaceArtifactPlan {
  return Object.freeze({
    kind: "artifact-output",
    summary: "Create a weekly decision brief.",
    expectedEffect: "Create one reviewed Markdown report while leaving the source brief unchanged.",
    outputPath: BUSINESS_BRIEF_SAMPLE.outputPath,
    outputMediaType: "text/markdown",
    script: `({ fs }) => {
  const source = fs.readText("/inputs/workspace/inputs/weekly-operations-brief.md");
  const lines = source.split(/\\r?\\n/);
  const section = (heading) => {
    const start = lines.findIndex((line) => line.trim() === "## " + heading);
    if (start < 0) return ["- No items provided."];
    const items = [];
    for (let index = start + 1; index < lines.length && !lines[index].startsWith("## "); index += 1) {
      if (lines[index].trim().startsWith("- ")) items.push(lines[index].trim());
    }
    return items.length ? items : ["- No items provided."];
  };
  const output = [
    "# Weekly decision brief",
    "",
    "## Decisions to make",
    ...section("Decisions needed"),
    "",
    "## Risks to watch",
    ...section("Risks"),
    "",
    "## Progress",
    ...section("Progress"),
    ""
  ].join("\\n");
  fs.writeText("/outputs/result.md", output);
  return { written: 1 };
}`,
    assumptions: Object.freeze(["The headings Progress, Decisions needed, and Risks identify the intended sections."]),
    warnings: Object.freeze(["Verify the decision owner and timing before sharing the report."]),
    model: "bundled-deterministic-sample",
    responseId: "sample_brief_to_report_v1",
    inputFiles: 1
  });
}
