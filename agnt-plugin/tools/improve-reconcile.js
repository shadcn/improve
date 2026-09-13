import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

class ImproveReconcileTool {
  constructor() {
    this.name = 'improve_reconcile';
  }

  async execute(params) {
    const repoPath = (params.repo_path || '').trim();
    const plansDirParam = (params.plans_dir || '').trim();

    if (!repoPath) {
      return { error: 'Missing required parameter: repo_path. Provide the absolute path to the repository root.' };
    }
    if (!existsSync(repoPath)) {
      return { error: `Path does not exist: ${repoPath}` };
    }

    const plansDir = plansDirParam || join(repoPath, 'plans');
    if (!existsSync(plansDir)) {
      return {
        success: true,
        message: `No plans directory found at ${plansDir}. Nothing to reconcile.`,
        plans_found: 0,
        actions: []
      };
    }

    // Read all plan files
    let planFiles;
    try {
      planFiles = readdirSync(plansDir)
        .filter(f => /^\d{3}-.+\.md$/.test(f))
        .sort();
    } catch (e) {
      return { error: `Cannot read plans directory: ${e.message}` };
    }

    if (planFiles.length === 0) {
      return {
        success: true,
        message: 'No plan files found (expected NNN-slug.md format). Nothing to reconcile.',
        plans_found: 0,
        actions: []
      };
    }

    const actions = [];
    const planStatuses = [];

    for (const file of planFiles) {
      const filepath = join(plansDir, file);
      let content;
      try {
        content = readFileSync(filepath, 'utf8');
      } catch (e) {
        actions.push({ file, action: 'error', detail: `Cannot read: ${e.message}` });
        continue;
      }

      const planNum = file.slice(0, 3);
      const status = { file, plan_number: planNum, issues: [] };

      // 1. Check for "Planned at" SHA and run drift check
      const plannedAtMatch = content.match(/Planned at.*?commit\s+`?([a-f0-9]+)/i);
      if (plannedAtMatch) {
        const plannedSha = plannedAtMatch[1];
        // Extract in-scope paths from drift check line
        const driftMatch = content.match(/git diff --stat\s+\S+\.\.\.\w+\s+--\s+(.+)/);
        if (driftMatch) {
          const scopePaths = driftMatch[1].trim().split(/\s+/);
          try {
            const { execSync } = await import('child_process');
            const diffStat = execSync(
              `git diff --stat ${plannedSha}..HEAD -- ${scopePaths.join(' ')}`,
              { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
            ).trim();
            if (diffStat) {
              status.drift = true;
              status.drift_detail = diffStat;
              status.issues.push('DRIFT: In-scope files changed since plan was written');
              actions.push({ file, action: 'drift_detected', detail: diffStat });
            } else {
              status.drift = false;
            }
          } catch (e) {
            status.issues.push('DRIFT_CHECK_ERROR: ' + e.message.slice(0, 100));
          }
        }
      }

      // 2. Check if plan was implemented (grep git log for plan reference)
      try {
        const { execSync } = await import('child_process');
        const logResult = execSync(
          `git log --oneline --all --grep="${file.slice(0, 3)}" 2>/dev/null || echo ""`,
          { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
        ).trim();
        if (logResult) {
          status.possibly_landed = true;
          status.landed_commits = logResult.split('\n').slice(0, 5);
          actions.push({ file, action: 'possibly_landed', detail: logResult.split('\n')[0] });
        } else {
          status.possibly_landed = false;
        }
      } catch (e) {
        status.possibly_landed = false;
      }

      // 3. Check plan quality (template compliance)
      const hasExecutorInstructions = content.includes('Executor instructions');
      const hasVerificationGates = content.includes('Verification gates') || content.includes('verification command');
      const hasStopConditions = content.includes('STOP conditions') || content.includes('STOP and report');
      const hasOutOfScope = content.includes('Out of scope') || content.includes('Out-of-scope');
      const hasCurrentState = content.includes('Current state') || content.includes('current code');

      status.quality = {
        has_executor_instructions: hasExecutorInstructions,
        has_verification_gates: hasVerificationGates,
        has_stop_conditions: hasStopConditions,
        has_out_of_scope: hasOutOfScope,
        has_current_state: hasCurrentState,
        score: [hasExecutorInstructions, hasVerificationGates, hasStopConditions, hasOutOfScope, hasCurrentState].filter(Boolean).length + '/5'
      };

      if (!hasStopConditions) status.issues.push('QUALITY: Missing STOP conditions');
      if (!hasVerificationGates) status.issues.push('QUALITY: Missing verification gates');
      if (!hasOutOfScope) status.issues.push('QUALITY: Missing out-of-scope boundaries');

      planStatuses.push(status);
    }

    // Rebuild plans/README.md index
    const readmePath = join(plansDir, 'README.md');
    const header = `# Plan Index

| Plan | File | Priority | Effort | Risk | Status | Depends on |
|---|---|---|---|---|---|---|
`;
    const rows = planStatuses.map(s => {
      const statusBadge = s.possibly_landed ? '✅ LANDED' : s.drift ? '⚠️ DRIFTED' : '📋 TODO';
      return `| ${s.plan_number} | [${s.file}](${s.file}) | — | — | — | ${statusBadge} | — |`;
    });
    const newReadme = header + rows.join('\n') + '\n';
    writeFileSync(readmePath, newReadme, 'utf8');
    actions.push({ file: 'README.md', action: 'rebuilt_index', detail: `Updated with ${planStatuses.length} plans` });

    return {
      success: true,
      plans_dir: plansDir,
      plans_found: planFiles.length,
      plans: planStatuses,
      actions,
      summary: {
        total: planFiles.length,
        possibly_landed: planStatuses.filter(s => s.possibly_landed).length,
        drifted: planStatuses.filter(s => s.drift).length,
        quality_issues: planStatuses.filter(s => s.issues.length > 0).length
      },
      message: `Reconciled ${planFiles.length} plans. ${actions.length} actions taken.`,
      next_steps: [
        'Review drifted plans and update them before dispatching to executors.',
        'Mark landed plans as DONE in plans/README.md.',
        'Fix quality issues in plans missing STOP conditions or verification gates.'
      ]
    };
  }
}

export default new ImproveReconcileTool();
