import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

class ImproveBranchAuditTool {
  constructor() {
    this.name = 'improve_branch_audit';
  }

  async execute(params) {
    const repoPath = (params.repo_path || '').trim();
    const baseBranch = (params.base_branch || 'main').trim();

    if (!repoPath) {
      return { error: 'Missing required parameter: repo_path. Provide the absolute path to the repository root.' };
    }
    if (!existsSync(repoPath)) {
      return { error: `Path does not exist: ${repoPath}` };
    }

    // Get current branch
    let currentBranch;
    try {
      currentBranch = execSync('git branch --show-current', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
    } catch (e) {
      return { error: 'Not a git repository or git not available.' };
    }

    if (!currentBranch) {
      return { error: 'Detached HEAD — cannot determine current branch.' };
    }

    if (currentBranch === baseBranch) {
      return {
        warning: `Currently on ${baseBranch} branch. Branch audit compares your branch against the base. Switch to a feature branch first.`,
        current_branch: currentBranch,
        base_branch: baseBranch
      };
    }

    // Get diff stats
    let diffStat;
    try {
      diffStat = execSync(
        `git diff --stat ${baseBranch}...HEAD`,
        { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
      ).trim();
    } catch (e) {
      return { error: `Cannot diff against ${baseBranch}: ${e.message}` };
    }

    // Get changed files list
    let changedFiles;
    try {
      changedFiles = execSync(
        `git diff --name-only ${baseBranch}...HEAD`,
        { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
      ).trim().split('\n').filter(Boolean);
    } catch (e) {
      changedFiles = [];
    }

    // Get commit log
    let commits;
    try {
      commits = execSync(
        `git log --oneline ${baseBranch}...HEAD`,
        { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
      ).trim().split('\n').filter(Boolean);
    } catch (e) {
      commits = [];
    }

    // Scan changed files for issues
    const findings = [];
    const scannableExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.sol', '.vy', '.move', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt', '.vue', '.svelte', '.sql', '.sh']);

    for (const file of changedFiles) {
      const ext = file.slice(file.lastIndexOf('.'));
      if (!scannableExts.has(ext)) continue;

      const filepath = join(repoPath, file);
      if (!existsSync(filepath)) continue; // deleted file

      let content;
      try {
        content = readFileSync(filepath, 'utf8');
      } catch (e) { continue; }

      const lines = content.split('\n');
      if (lines.length > 3000) continue; // skip huge files

      // Check for common issues in changed files
      const checks = [
        { pattern: /console\.(log|debug|info|warn)\s*\(/g, finding: 'Console statement left in code' },
        { pattern: /debugger\s*;/g, finding: '`debugger` statement left in code' },
        { pattern: /TODO[:]/gi, finding: 'TODO comment — unresolved work item' },
        { pattern: /FIXME[:]/gi, finding: 'FIXME comment — known issue' },
        { pattern: /HACK[:]/gi, finding: 'HACK comment — temporary workaround' },
        { pattern: /@ts-ignore/g, finding: '`@ts-ignore` suppresses type errors' },
        { pattern: /@ts-nocheck/g, finding: '`@ts-nocheck` disables type checking' },
        { pattern: /\bany\b/g, finding: 'TypeScript `any` type escape hatch' },
        { pattern: /catch\s*\(\s*\w+\s*\)\s*\{\s*\}/gim, finding: 'Empty catch block' },
        { pattern: /eval\s*\(/g, finding: '`eval()` usage — code injection risk' },
        { pattern: /innerHTML\s*=/g, finding: '`innerHTML` assignment — XSS risk' },
        { pattern: /dangerouslySetInnerHTML/g, finding: '`dangerouslySetInnerHTML` — XSS risk' },
      ];

      for (const check of checks) {
        check.pattern.lastIndex = 0;
        let match;
        while ((match = check.pattern.exec(content)) !== null) {
          const lineNum = content.substring(0, match.index).split('\n').length;
          findings.push({
            file,
            line: lineNum,
            finding: check.finding,
            severity: check.finding.includes('XSS') || check.finding.includes('injection') ? 'HIGH' : 'LOW',
            evidence: lines[lineNum - 1]?.trim().slice(0, 120) || ''
          });
          if (findings.length > 100) break;
        }
        if (findings.length > 100) break;
      }
    }

    // Check for plan alignment — are there plans for these files?
    const plansDir = join(repoPath, 'plans');
    let planAlignment = [];
    if (existsSync(plansDir)) {
      try {
        const planFiles = execSync('ls *.md 2>/dev/null || echo ""', { cwd: plansDir, encoding: 'utf8', timeout: 5000 })
          .trim().split('\n').filter(Boolean);
        for (const pf of planFiles) {
          if (pf === 'README.md') continue;
          try {
            const planContent = readFileSync(join(plansDir, pf), 'utf8');
            const matchedFiles = changedFiles.filter(f => planContent.includes(f));
            if (matchedFiles.length > 0) {
              planAlignment.push({ plan: pf, covers_files: matchedFiles });
            }
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* no plans */ }
    }

    // Scope creep detection: files changed that aren't covered by any plan
    const plannedFiles = new Set(planAlignment.flatMap(p => p.covers_files));
    const unplannedFiles = changedFiles.filter(f => !plannedFiles.has(f) && scannableExts.has(f.slice(f.lastIndexOf('.'))));

    // Sort findings by severity
    const sevOrder = { HIGH: 0, MED: 1, LOW: 2 };
    findings.sort((a, b) => (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2));

    return {
      success: true,
      branch: currentBranch,
      base_branch: baseBranch,
      summary: {
        commits: commits.length,
        changed_files: changedFiles.length,
        findings: findings.length,
        plans_aligned: planAlignment.length,
        unplanned_changed_files: unplannedFiles.length
      },
      diff_stat: diffStat,
      commits,
      changed_files: changedFiles,
      findings,
      plan_alignment: planAlignment,
      scope_creep: {
        unplanned_files: unplannedFiles,
        warning: unplannedFiles.length > 0
          ? `${unplannedFiles.length} changed files are not covered by any plan. Consider creating plans for these changes.`
          : 'All changed files are covered by existing plans.'
      },
      message: `Branch audit complete: ${commits.length} commits, ${changedFiles.length} files changed, ${findings.length} issues found.`,
      next_steps: findings.length > 0
        ? ['Address HIGH severity findings before merging.', 'Create plans for unplanned changed files if they represent significant work.']
        : ['No issues found. Branch looks clean for PR.'],
      skill_reference: 'shadcn/improve v1.0.0 — https://github.com/shadcn/improve'
    };
  }
}

export default new ImproveBranchAuditTool();
