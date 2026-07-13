import type { WorkspaceFile } from "./workspace";

export const FIRST_RUN_CSV_SAMPLE = Object.freeze({
  fileName: "wasmhatch-pipeline-sample.csv",
  mediaType: "text/csv;charset=utf-8",
  task: "Normalize names and regions, convert amounts to numbers, and standardize stages.",
  content: `Owner,Region,Amount,Stage
"  aya tanaka"," west ","12,400",won
"KEN ITO  ",East,8300,OPEN
" mei sato "," north","6,250"," Won "
`
});

/** The chat surface's sample workspace: one messy spreadsheet, matching the hero copy. */
export const FIRST_RUN_SAMPLE_FILES: readonly WorkspaceFile[] = Object.freeze([
  Object.freeze({ path: FIRST_RUN_CSV_SAMPLE.fileName, content: FIRST_RUN_CSV_SAMPLE.content })
]);
