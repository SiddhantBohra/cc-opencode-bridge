import pc from "picocolors";

/**
 * Minimal line-based diff renderer for ACP `diff` tool content.
 * Produces Claude-Code-style output: red `-` lines, green `+` lines,
 * dim context lines, with unchanged regions collapsed.
 */

type Op = { kind: "same" | "del" | "add"; line: string };

/** LCS-based line diff. Falls back to whole-file replace beyond the size cap. */
function diffLines(oldLines: string[], newLines: string[]): Op[] {
  const n = oldLines.length;
  const m = newLines.length;

  // O(n*m) DP — cap to keep the daemon responsive on huge files.
  if (n * m > 250_000) {
    return [
      ...oldLines.map((line): Op => ({ kind: "del", line })),
      ...newLines.map((line): Op => ({ kind: "add", line })),
    ];
  }

  // LCS table
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk the table to produce ops
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "same", line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", line: oldLines[i] });
      i++;
    } else {
      ops.push({ kind: "add", line: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", line: oldLines[i++] });
  while (j < m) ops.push({ kind: "add", line: newLines[j++] });
  return ops;
}

export type RenderDiffOptions = {
  /** Context lines around each change hunk (default 2). */
  context?: number;
  /** Max rendered lines before truncating (default 80). */
  maxLines?: number;
  /** Left indent for every rendered line. */
  indent?: string;
};

/**
 * Render a colored diff between two file contents.
 * Returns "" when there is no change.
 */
export function renderDiff(
  oldText: string | null | undefined,
  newText: string,
  opts: RenderDiffOptions = {},
): string {
  const context = opts.context ?? 2;
  const maxLines = opts.maxLines ?? 80;
  const pad = opts.indent ?? "    ";

  const oldLines = (oldText ?? "").split("\n");
  const newLines = newText.split("\n");

  // New file — render all-additions (no LCS needed).
  const ops: Op[] =
    oldText == null || oldText === ""
      ? newLines.map((line): Op => ({ kind: "add", line }))
      : diffLines(oldLines, newLines);

  if (!ops.some((o) => o.kind !== "same")) return "";

  // Mark which "same" lines to keep (within `context` of any change).
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].kind !== "same") {
      for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) {
        keep[c] = true;
      }
    }
  }

  const out: string[] = [];
  let truncated = false;
  let skipping = false;
  for (let k = 0; k < ops.length; k++) {
    if (out.length >= maxLines) {
      truncated = true;
      break;
    }
    const op = ops[k];
    if (op.kind === "same" && !keep[k]) {
      if (!skipping) {
        out.push(pc.dim(`${pad}⋮`));
        skipping = true;
      }
      continue;
    }
    skipping = false;
    if (op.kind === "same") {
      out.push(pc.dim(`${pad}  ${op.line}`));
    } else if (op.kind === "del") {
      out.push(pc.red(`${pad}- ${op.line}`));
    } else {
      out.push(pc.green(`${pad}+ ${op.line}`));
    }
  }
  if (truncated) {
    const remaining = ops.filter((o) => o.kind !== "same").length;
    out.push(pc.dim(`${pad}… (diff truncated, ${remaining} changed lines total)`));
  }
  return out.join("\n");
}
