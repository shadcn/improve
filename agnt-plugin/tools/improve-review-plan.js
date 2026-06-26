import { readFileSync, existsSync } from 'fs';

class ImproveReviewPlanTool {
  constructor() {
    this.name = 'improve-review-plan';
  }

  async execute(params) {
    const planPath = (params.plan_path || '').trim();

    if (!planPath) {
      return { error: 'Missing required parameter: plan_path. Provide the absolute path to the .md plan file.' };
    }
    if (!existsSync(planPath)) {
      return { error: 'File does not exist: ' + planPath };
    }

    let content;
    try {
      content = readFileSync(planPath, 'utf8');
    } catch (e) {
      return { error: 'Cannot read file: ' + e.message };
    }

    const checks = [];

    // 1. Executor instructions block
    const hasExecutorInstructions = content.includes('Executor instructions') || content.includes('executor instructions');
    checks.push({
      dimension: 'Executor Instructions',
      description: 'Plan has a clear executor preamble telling the agent how to use it',
      pass: hasExecutorInstructions,
      detail: hasExecutorInstructions
        ? 'Found executor instructions block.'
        : 'Missing executor instructions. Add a blockquote at the top.'
    });

    // 2. Drift check
    const hasDriftCheck = content.includes('git diff --stat') || content.includes('Drift check');
    checks.push({
      dimension: 'Drift Check',
      description: 'Plan includes a drift check command to verify target files haven\'t changed',
      pass: hasDriftCheck,
      detail: hasDriftCheck
        ? 'Found drift check command.'
        : 'Missing drift check. Add: **Drift check (run first)**: git diff --stat SHA..HEAD -- paths'
    });

    // 3. Self-contained context (current state excerpts)
    const hasCurrentState = content.includes('Current state') || content.includes('current state') || content.includes('Current code');
    const hasCodeExcerpts = content.includes('```') && (content.includes('.ts') || content.includes('.js') || content.includes('.py') || content.includes('.rs') || content.includes('.go') || content.includes('.sol'));
    checks.push({
      dimension: 'Self-Contained Context',
      description: 'Plan includes current state code excerpts so executor has zero context dependency',
      pass: hasCurrentState && hasCodeExcerpts,
      detail: (hasCurrentState && hasCodeExcerpts)
        ? 'Found current state section with code excerpts.'
        : 'Missing current state section or code excerpts.'
    });

    // 4. Verification gates
    const hasVerificationGates = content.includes('Verification gates') || content.includes('verification command') || content.includes('Verification:');
    const hasTestCommand = content.includes('npm test') || content.includes('cargo test') || content.includes('go test') || content.includes('pytest') || content.includes('bun test');
    checks.push({
      dimension: 'Verification Gates',
      description: 'Every step ends with a command and expected result; plan includes repo test/build/lint commands',
      pass: hasVerificationGates && hasTestCommand,
      detail: (hasVerificationGates && hasTestCommand)
        ? 'Found verification gates with test commands.'
        : 'Missing verification gates section or test command.'
    });

    // 5. STOP conditions
    const hasStopConditions = content.includes('STOP conditions') || content.includes('STOP and report') || content.includes('stop and report');
    checks.push({
      dimension: 'STOP Conditions',
      description: 'Plan has explicit STOP conditions for when reality doesn\'t match the plan',
      pass: hasStopConditions,
      detail: hasStopConditions
        ? 'Found STOP conditions section.'
        : 'Missing STOP conditions. Add a section listing when the executor should stop and report.'
    });

    // 6. Out of scope
    const hasOutOfScope = content.includes('Out of scope') || content.includes('Out-of-scope') || content.includes('out of scope');
    checks.push({
      dimension: 'Out of Scope Boundaries',
      description: 'Plan explicitly lists what is NOT in scope to prevent scope creep',
      pass: hasOutOfScope,
      detail: hasOutOfScope
        ? 'Found out-of-scope section.'
        : 'Missing out-of-scope boundaries. Add: ## Out of scope listing what the executor should NOT do.'
    });

    // 7. Numbered steps
    const numberedSteps = content.match(/^\d+\.\s+/gm) || [];
    checks.push({
      dimension: 'Numbered Steps',
      description: 'Plan has clear numbered implementation steps',
      pass: numberedSteps.length >= 3,
      detail: numberedSteps.length >= 3
        ? 'Found ' + numberedSteps.length + ' numbered steps.'
        : 'Only ' + numberedSteps.length + ' numbered steps found. Aim for 3-7 clear steps.'
    });

    // 8. Why this matters
    const hasWhy = content.includes('Why this matters') || content.includes('## Why') || content.includes('## Context');
    checks.push({
      dimension: 'Motivation / Why This Matters',
      description: 'Plan explains why the change is worth making',
      pass: hasWhy,
      detail: hasWhy
        ? 'Found motivation section.'
        : 'Missing Why this matters section. Explain the impact so the executor understands priority.'
    });

    // 9. Status metadata
    const hasPriority = content.includes('**Priority**');
    const hasEffort = content.includes('**Effort**');
    const hasRisk = content.includes('**Risk**');
    const metaDetail = 'Priority: ' + (hasPriority ? 'Y' : 'N') + ', Effort: ' + (hasEffort ? 'Y' : 'N') + ', Risk: ' + (hasRisk ? 'Y' : 'N');
    checks.push({
      dimension: 'Status Metadata',
      description: 'Plan includes Priority, Effort, and Risk fields',
      pass: hasPriority && hasEffort && hasRisk,
      detail: metaDetail
    });

    // 10. File naming convention
    const filename = planPath.split('/').pop() || planPath.split('\\').pop();
    const hasCorrectNaming = /^\d{3}-.+\.md$/.test(filename);
    checks.push({
      dimension: 'File Naming',
      description: 'Plan file follows NNN-slug.md naming convention',
      pass: hasCorrectNaming,
      detail: hasCorrectNaming
        ? 'Filename "' + filename + '" follows convention.'
        : 'Filename "' + filename + '" should match NNN-slug.md (e.g. 001-fix-n-plus-one.md).'
    });

    // Score
    const passed = checks.filter(c => c.pass).length;
    const total = checks.length;
    const score = passed + '/' + total;

    let verdict;
    if (passed === total) verdict = 'EXCELLENT';
    else if (passed >= 8) verdict = 'GOOD';
    else if (passed >= 5) verdict = 'NEEDS WORK';
    else verdict = 'INCOMPLETE';

    return {
      success: true,
      plan_file: filename,
      plan_path: planPath,
      score: score,
      verdict: verdict,
      checks: checks,
      failed_checks: checks.filter(c => !c.pass),
      passed_checks: checks.filter(c => c.pass),
      template_reference: 'https://github.com/shadcn/improve/blob/main/skills/improve/references/plan-template.md',
      message: verdict + ' Score: ' + score
    };
  }
}

export default new ImproveReviewPlanTool();
