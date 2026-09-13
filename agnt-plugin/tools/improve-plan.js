import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

class ImprovePlanTool {
  constructor() {
    this.name = 'improve_plan';
  }

  async execute(params) {
    const finding = (params.finding || '').trim();
    const repoPath = (params.repo_path || '').trim();
    const planNumber = parseInt(params.plan_number) || 0;
    const outputDir = (params.output_dir || '').trim();

    if (!finding) {
      return { error: 'Missing required parameter: finding. Describe the improvement with file:line references.' };
    }
    if (!repoPath) {
      return { error: 'Missing required parameter: repo_path. Provide the absolute path to the repository root.' };
    }
    if (!existsSync(repoPath)) {
      return { error: `Path does not exist: ${repoPath}` };
    }

    // Determine output directory
    const plansDir = outputDir || join(repoPath, 'plans');
    if (!existsSync(plansDir)) {
      mkdirSync(plansDir, { recursive: true });
    }

    // Auto-increment plan number if not provided
    let num = planNumber;
    if (num === 0) {
      try {
        const existing = readdirSync(plansDir)
          .filter(f => /^\d{3}-.+\.md$/.test(f))
          .map(f => parseInt(f.slice(0, 3)))
          .sort((a, b) => b - a);
        num = existing.length > 0 ? existing[0] + 1 : 1;
      } catch (e) {
        num = 1;
      }
    }

    // Extract a slug from the finding
    const slug = finding
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .slice(0, 6)
      .join('-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const padded = String(num).padStart(3, '0');
    const filename = `${padded}-${slug}.md`;
    const filepath = join(plansDir, filename);

    // Try to extract file:line references from the finding
    const fileRefs = [];
    const refRegex = /([\w./-]+):(\d+)/g;
    let refMatch;
    while ((refMatch = refRegex.exec(finding)) !== null) {
      fileRefs.push({ file: refMatch[1], line: parseInt(refMatch[2]) });
    }

    // Try to read current state excerpts for referenced files
    const currentExcerpts = [];
    for (const ref of fileRefs.slice(0, 5)) {
      const filePath = join(repoPath, ref.file);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf8');
          const lines = content.split('\n');
          const start = Math.max(0, ref.line - 3);
          const end = Math.min(lines.length, ref.line + 10);
          const excerpt = lines.slice(start, end).join('\n');
          currentExcerpts.push({
            file: ref.file,
            line: ref.line,
            excerpt: `\`\`\`\n${excerpt}\n\`\`\``
          });
        } catch (e) { /* skip unreadable */ }
      }
    }

    // Detect git SHA
    let gitSha = 'unknown';
    try {
      const { execSync } = await import('child_process');
      gitSha = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim().slice(0, 8);
    } catch (e) { /* not a git repo */ }

    // Build the plan in shadcn/improve handoff format
    const titleCase = finding.charAt(0).toUpperCase() + finding.slice(1);
    const inScopePaths = fileRefs.map(f => f.file).join(', ') || '(to be determined by executor)';

    const plan = `# Plan ${padded}: ${titleCase}

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in \`plans/README.md\` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: \`git diff --stat ${gitSha}..HEAD -- ${inScopePaths}\`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: (to be classified)
- **Planned at**: commit \`${gitSha}\`, ${new Date().toISOString().slice(0, 10)}

## Why this matters

${finding}

${currentExcerpts.length > 0 ? `## Current state\n\n${currentExcerpts.map(e => `### \`${e.file}\` (around line ${e.line})\n\n${e.excerpt}`).join('\n\n')}` : '## Current state\n\n(No file references detected — executor should locate the relevant code before proceeding.)'}

## Steps

1. **Locate the code.** Find the file(s) and function(s) involved.
   - Verification: \`grep -rn "<pattern>" <path>\` returns the expected matches.

2. **Understand the current behavior.** Read the surrounding code (at least 20 lines of context).
   - Verification: You can explain what the current code does in 2-3 sentences.

3. **Implement the fix/improvement.** Make the minimal change that addresses the finding.
   - Verification: The changed code compiles / passes lint.

4. **Add or update tests.** Ensure the fix is covered by at least one test.
   - Verification: \`npm test\` (or repo's test command) passes.

5. **Verify no regressions.** Run the full test suite.
   - Verification: All existing tests still pass.

## Verification gates

- Build: \`(detect from repo — e.g. npm run build)\`
- Test: \`(detect from repo — e.g. npm test)\`
- Lint: \`(detect from repo — e.g. npm run lint)\`

## STOP conditions

- If the referenced file:line no longer exists or has changed significantly since this plan was written, STOP and report the drift.
- If implementing this fix requires changing more than 3 files, STOP and report — the plan may need updating.
- If a test you didn't modify starts failing, STOP and report.

## Out of scope

- Refactoring unrelated code.
- Changing the public API of the module.
- Adding new dependencies.

---

*Generated by improve_plan tool — shadcn/improve v1.0.0 adaptation for AGNT*
*Source: https://github.com/shadcn/improve*
`;

    // Write the plan file
    writeFileSync(filepath, plan, 'utf8');

    // Update or create plans/README.md index
    const readmePath = join(plansDir, 'README.md');
    const statusRow = `| ${padded} | [${filename}](${filename}) | P2 | M | MED | TODO | — |`;
    let readme;
    if (existsSync(readmePath)) {
      readme = readFileSync(readmePath, 'utf8');
      // Append to table or create table if missing
      if (readme.includes('| Plan |')) {
        // Insert after header row
        const lines = readme.split('\n');
        let insertIdx = lines.findIndex(l => l.startsWith('|---'));
        if (insertIdx >= 0) {
          lines.splice(insertIdx + 1, 0, statusRow);
        }
        readme = lines.join('\n');
      } else {
        readme += `\n\n| Plan | File | Priority | Effort | Risk | Status | Depends on |\n|---|---|---|---|---|---|---|\n${statusRow}\n`;
      }
      writeFileSync(readmePath, readme, 'utf8');
    } else {
      readme = `# Plan Index

| Plan | File | Priority | Effort | Risk | Status | Depends on |
|---|---|---|---|---|---|---|
${statusRow}
`;
      writeFileSync(readmePath, readme, 'utf8');
    }

    return {
      success: true,
      plan_file: filename,
      plan_path: filepath,
      plan_number: num,
      slug,
      git_sha: gitSha,
      file_references_found: fileRefs.length,
      current_state_excerpts: currentExcerpts.length,
      message: `Plan written to ${filepath}`,
      next_steps: [
        `Review the plan: ${filepath}`,
        `Hand it to an executor agent: "implement ${filepath}"`,
        `Or use improve_execute to dispatch and review automatically.`,
        `Run improve_reconcile to keep the backlog healthy.`
      ]
    };
  }
}

export default new ImprovePlanTool();
