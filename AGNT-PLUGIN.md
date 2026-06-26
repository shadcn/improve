# AGNT Plugin Integration

This directory contains the AGNT plugin adaptation of the shadcn/improve agent skill.

## What it is

The improve plugin brings the shadcn/improve agent skill to AGNT as 5 native workflow tools. It audits any codebase and writes prioritized, self-contained implementation plans for other agents to execute — never editing source code itself.

## Tools

| Tool | Description |
|---|---|
| `improve_audit` | Full/focused codebase audit. Maps repo structure, conventions, build commands. Scans for bugs, security, perf, test gaps, tech debt. Returns prioritized findings with file:line evidence. |
| `improve_plan` | Writes a self-contained implementation plan in shadcn/improve handoff format. Includes current state excerpts, verification gates, STOP conditions, and out-of-scope boundaries. |
| `improve_reconcile` | Scans `plans/` directory and reconciles the backlog: verifies landed plans, refreshes drifted ones, unblocks stuck plans, retires stale ones. |
| `improve_review_plan` | Critiques an existing plan against the shadcn/improve handoff template. Checks 10 dimensions: executor instructions, drift check, context, verification gates, STOP conditions, and more. |
| `improve_branch_audit` | Audits only what the current git branch changes vs base. Finds issues introduced by the branch, checks plan alignment, flags scope creep. |

## Installation

The plugin is installed at `C:\Users\jacks\AppData\Roaming\AGNT\plugins\installed\improve\` and loaded by AGNT.

## Source

- Original skill: https://github.com/shadcn/improve
- This repo: https://github.com/jacksonjp0311-gif/improve-AGNT
