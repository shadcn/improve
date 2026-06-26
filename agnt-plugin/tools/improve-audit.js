import { execSync } from 'child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';

const SKILL_FRONTMATTER = `---
name: improve
description: Survey any codebase as a senior advisor and produce prioritized, self-contained implementation plans for OTHER models/agents to execute. Strictly read-only on source code.
license: MIT
metadata:
  author: shadcn
  version: "1.0.0"
---`;

const AUDIT_CATEGORIES = {
  bugs: {
    label: 'Correctness / Bugs',
    checks: [
      { pattern: /catch\s*\(\s*\w+\s*\)\s*\{\s*\}/gim, finding: 'Empty catch block — error silently swallowed' },
      { pattern: /catch\s*\(\s*\w+\s*\)\s*\{[^}]*console\.(log|error|warn)\s*\(/gim, finding: 'Catch block only logs — no recovery or re-throw on critical path' },
      { pattern: /\bany\b/g, finding: 'TypeScript `any` type escape hatch — compiler bypassed' },
      { pattern: /@ts-ignore/g, finding: '`@ts-ignore` suppresses type errors' },
      { pattern: /@ts-nocheck/g, finding: '`@ts-nocheck` disables type checking for entire file' },
      { pattern: /!\s*\]/g, finding: 'Non-null assertion on array access — potential undefined' },
      { pattern: /\.then\s*\(\s*\(\s*\)\s*=>\s*\{[^}]*\}\s*\)\s*\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/gim, finding: 'Promise with empty catch — unhandled rejection risk' },
      { pattern: /addEventListener\s*\([^)]*\)(?!.*removeEventListener)/gim, finding: 'Event listener added without corresponding removeEventListener — potential memory leak' },
    ]
  },
  security: {
    label: 'Security',
    checks: [
      { pattern: /eval\s*\(/g, finding: '`eval()` usage — code injection risk' },
      { pattern: /innerHTML\s*=/g, finding: '`innerHTML` assignment — XSS risk' },
      { pattern: /dangerouslySetInnerHTML/g, finding: '`dangerouslySetInnerHTML` — XSS risk if content is not sanitized' },
      { pattern: /child_process.*exec\s*\(/g, finding: '`child_process.exec()` — shell injection risk if input is not sanitized' },
      { pattern: /password\s*=\s*["'][^"']+["']/gi, finding: 'Hardcoded password detected' },
      { pattern: /api[_-]?key\s*=\s*["'][^"']+["']/gi, finding: 'Hardcoded API key detected' },
      { pattern: /secret\s*=\s*["'][^"']{8,}["']/gi, finding: 'Hardcoded secret detected' },
      { pattern: /http:\/\//g, finding: 'Insecure HTTP URL — should use HTTPS' },
    ]
  },
  perf: {
    label: 'Performance',
    checks: [
      { pattern: /for\s*\([^)]+\)\s*\{[^}]*\.find\s*\(/gim, finding: 'Loop + `.find()` — O(n²) pattern, consider a Map/Set' },
      { pattern: /for\s*\([^)]+\)\s*\{[^}]*\.filter\s*\(/gim, finding: 'Loop + `.filter()` — O(n²) pattern' },
      { pattern: /for\s*\([^)]+\)\s*\{[^}]*\.includes\s*\(/gim, finding: 'Loop + `.includes()` — O(n²) pattern, consider a Set' },
      { pattern: /JSON\.parse\s*\(\s*JSON\.stringify\s*\(/g, finding: 'Deep clone via JSON.parse(JSON.stringify()) — slow for large objects, consider structured clone' },
      { pattern: /document\.getElementById/g, finding: 'Direct DOM access in component — consider refs/state instead' },
    ]
  },
  tests: {
    label: 'Test Coverage',
    checks: [
      { pattern: /describe\.skip\s*\(/g, finding: 'Skipped test suite (`describe.skip`)' },
      { pattern: /it\.skip\s*\(|test\.skip\s*\(/g, finding: 'Skipped test case (`it.skip` / `test.skip`)' },
      { pattern: /\.only\s*\(/g, finding: '`.only` on test — will skip other tests in suite' },
    ]
  },
  debt: {
    label: 'Tech Debt',
    checks: [
      { pattern: /TODO[:]/gi, finding: 'TODO comment — unresolved work item' },
      { pattern: /FIXME[:]/gi, finding: 'FIXME comment — known issue not addressed' },
      { pattern: /HACK[:]/gi, finding: 'HACK comment — temporary workaround' },
      { pattern: /XXX[:]/gi, finding: 'XXX comment — flagged concern' },
      { pattern: /console\.(log|debug|info|warn)\s*\(/g, finding: 'Console statement left in production code' },
      { pattern: /debugger\s*;/g, finding: '`debugger` statement left in code' },
    ]
  }
};

const QUICK_CHECKS = ['bugs', 'debt'];
const FOCUS_MAP = {
  security: ['security'],
  perf: ['perf'],
  tests: ['tests'],
  bugs: ['bugs'],
};

function walkDir(dir, excludeDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor']) {
  let files = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.includes(entry.name)) {
          files = files.concat(walkDir(full, excludeDirs));
        }
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  } catch (e) { /* skip unreadable dirs */ }
  return files;
}

function detectStack(files) {
  const stack = new Set();
  const fileSet = new Set(files.map(f => f.toLowerCase()));
  if (fileSet.has('package.json') || files.some(f => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx'))) stack.add('JavaScript/TypeScript');
  if (files.some(f => f.endsWith('.py'))) stack.add('Python');
  if (files.some(f => f.endsWith('.rs'))) stack.add('Rust');
  if (files.some(f => f.endsWith('.go'))) stack.add('Go');
  if (files.some(f => f.endsWith('.java'))) stack.add('Java');
  if (files.some(f => f.endsWith('.sol'))) stack.add('Solidity');
  if (files.some(f => f.endsWith('.vy'))) stack.add('Vyper');
  if (files.some(f => f.endsWith('.move'))) stack.add('Move');
  if (files.some(f => f.endsWith('.tsx') || f.endsWith('.jsx'))) stack.add('React');
  if (files.some(f => f.endsWith('.vue'))) stack.add('Vue');
  if (files.some(f => f.endsWith('.svelte'))) stack.add('Svelte');
  if (fileSet.has('cargo.toml')) stack.add('Rust (Cargo)');
  if (fileSet.has('go.mod')) stack.add('Go Modules');
  if (fileSet.has('requirements.txt') || fileSet.has('pyproject.toml') || fileSet.has('setup.py')) stack.add('Python');
  if (fileSet.has('hardhat.config.js') || fileSet.has('hardhat.config.ts') || fileSet.has('foundry.toml')) stack.add('Ethereum (Hardhat/Foundry)');
  return [...stack];
}

function detectCommands(repoPath) {
  const cmds = {};
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    if (scripts.test) cmds.test = `npm test`;
    if (scripts.build) cmds.build = `npm run build`;
    if (scripts.lint) cmds.lint = `npm run lint`;
    if (scripts['typecheck'] || scripts.typecheck) cmds.typecheck = `npm run typecheck`;
    if (scripts.format) cmds.format = `npm run format`;
  } catch (e) { /* no package.json */ }
  if (existsSync(join(repoPath, 'Cargo.toml'))) cmds.test = 'cargo test';
  if (existsSync(join(repoPath, 'go.mod'))) cmds.test = 'go test ./...';
  if (existsSync(join(repoPath, 'pyproject.toml'))) cmds.test = 'pytest';
  return cmds;
}

function scanFile(filePath, categories) {
  const findings = [];
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (e) { return findings; }

  const lines = content.split('\n');
  const maxLines = 5000;
  if (lines.length > maxLines) return findings; // skip huge files

  for (const cat of categories) {
    const catDef = AUDIT_CATEGORIES[cat];
    if (!catDef) continue;
    for (const check of catDef.checks) {
      // Reset regex lastIndex
      check.pattern.lastIndex = 0;
      let match;
      while ((match = check.pattern.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const lineContent = lines[lineNum - 1]?.trim().slice(0, 120) || '';
        findings.push({
          category: catDef.label,
          severity: cat === 'security' ? 'HIGH' : cat === 'bugs' ? 'HIGH' : cat === 'perf' ? 'MED' : 'LOW',
          file: filePath,
          line: lineNum,
          finding: check.finding,
          evidence: lineContent
        });
        if (findings.length > 200) return findings; // cap
      }
    }
  }
  return findings;
}

class ImproveAuditTool {
  constructor() {
    this.name = 'improve_audit';
  }

  async execute(params) {
    const repoPath = (params.repo_path || '').trim();
    const mode = (params.mode || 'full').trim();
    const focusPaths = (params.focus_paths || '').trim();

    if (!repoPath) {
      return { error: 'Missing required parameter: repo_path. Provide the absolute path to the repository root.' };
    }
    if (!existsSync(repoPath)) {
      return { error: `Path does not exist: ${repoPath}` };
    }

    // Determine which categories to scan
    let categories;
    if (FOCUS_MAP[mode]) {
      categories = FOCUS_MAP[mode];
    } else if (mode === 'quick') {
      categories = QUICK_CHECKS;
    } else {
      categories = Object.keys(AUDIT_CATEGORIES); // full, deep, or default
    }

    // Gather files
    let files;
    if (focusPaths) {
      const paths = focusPaths.split(',').map(p => join(repoPath, p.trim()));
      files = [];
      for (const p of paths) {
        if (statSync(p).isDirectory()) {
          files = files.concat(walkDir(p));
        } else {
          files.push(p);
        }
      }
    } else {
      files = walkDir(repoPath);
    }

    // Filter to scannable text files
    const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.sol', '.vy', '.move', '.c', '.cpp', '.h', '.hpp', '.rb', '.php', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.yaml', '.yml', '.toml', '.json', '.md', '.vue', '.svelte', '.css', '.scss', '.less', '.html', '.xml', '.graphql', '.gql']);
    const scannable = files.filter(f => exts.has(f.slice(f.lastIndexOf('.'))) && !f.includes('node_modules/') && !f.includes('dist/') && !f.includes('build/') && !f.includes('.next/'));

    // Detect stack and commands
    const stack = detectStack(files.map(f => f.toLowerCase()));
    const commands = detectCommands(repoPath);

    // Scan files
    let allFindings = [];
    for (const file of scannable) {
      const fileFindings = scanFile(file, categories);
      allFindings = allFindings.concat(fileFindings);
      if (allFindings.length > 200) {
        allFindings = allFindings.slice(0, 200);
        break;
      }
    }

    // Deduplicate by file+line+finding
    const seen = new Set();
    const deduped = allFindings.filter(f => {
      const key = `${f.file}:${f.line}:${f.finding}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by severity
    const sevOrder = { HIGH: 0, MED: 1, LOW: 2 };
    deduped.sort((a, b) => (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2));

    // Build summary
    const byCategory = {};
    const bySeverity = { HIGH: 0, MED: 0, LOW: 0 };
    for (const f of deduped) {
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }

    // Get git info
    let gitInfo = {};
    try {
      gitInfo.branch = execSync('git branch --show-current', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
      gitInfo.lastCommit = execSync('git log -1 --format="%h|%s|%ar"', { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim().split('|');
    } catch (e) { gitInfo = { branch: 'N/A', lastCommit: ['N/A', 'N/A', 'N/A'] }; }

    return {
      summary: {
        repo: repoPath,
        mode,
        branch: gitInfo.branch,
        lastCommit: { sha: gitInfo.lastCommit?.[0], subject: gitInfo.lastCommit?.[1], relative: gitInfo.lastCommit?.[2] },
        stack,
        commands,
        totalFiles: scannable.length,
        totalFindings: deduped.length,
        bySeverity,
        byCategory
      },
      findings: deduped,
      skill_reference: 'shadcn/improve v1.0.0 — https://github.com/shadcn/improve',
      next_steps: [
        'Review the findings table above.',
        'Pick findings to plan: use improve_plan with the finding description and file:line reference.',
        'Plans are written to plans/NNN-slug.md in the repo.',
        'Use improve_execute to dispatch an executor agent, or hand the plan to any agent.',
        'Run improve_reconcile to keep the backlog healthy.'
      ]
    };
  }
}

export default new ImproveAuditTool();
