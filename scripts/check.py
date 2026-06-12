#!/usr/bin/env python3
"""
Structural checker for shadcn/improve.
Uses Python 3 stdlib only (no PyYAML — frontmatter fields are checked by
regex/substring, not parsed as YAML).

Checks:
  1. Frontmatter presence and required fields in skills/improve/SKILL.md
  2. Plugin manifest validity and name/version agreement
  3. Relative links resolve in all *.md files (fenced-code-block links skipped)
  4. Invocation variant parity between README.md and SKILL.md
  5. version: in SKILL.md metadata block equals plugin.json version
"""

import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

failures = []


def fail(msg):
    failures.append(msg)
    print(f"FAIL {msg}")


def ok(label):
    print(f"PASS {label}")


# ---------------------------------------------------------------------------
# Check 1: Frontmatter presence and required fields
# ---------------------------------------------------------------------------

SKILL_PATH = os.path.join(REPO_ROOT, "skills", "improve", "SKILL.md")

with open(SKILL_PATH, encoding="utf-8") as f:
    skill_lines = f.readlines()
    skill_text = "".join(skill_lines)

# Must start with ---
if not skill_lines[0].strip() == "---":
    fail("check1: SKILL.md does not start with ---")
else:
    # Find closing ---
    close_idx = None
    for i, line in enumerate(skill_lines[1:], start=1):
        if line.strip() == "---":
            close_idx = i
            break
    if close_idx is None:
        fail("check1: SKILL.md frontmatter has no closing ---")
    else:
        fm_lines = skill_lines[1:close_idx]
        fm_text = "".join(fm_lines)

        # Require non-empty values: pattern matches "name: <value>" and
        # "description: <value>" (note trailing space before value is required
        # per spec — ensures the field is populated, not just present).
        has_name = any(re.match(r"^name:\s+\S", l) for l in fm_lines)
        has_desc = any(re.match(r"^description:\s+\S", l) for l in fm_lines)

        if not has_name:
            fail("check1: SKILL.md frontmatter missing or empty 'name:' field")
        if not has_desc:
            fail("check1: SKILL.md frontmatter missing or empty 'description:' field")

        # name value must be "improve"
        name_match = None
        for l in fm_lines:
            m = re.match(r"^name:\s+(\S.*)", l)
            if m:
                name_match = m.group(1).strip()
                break
        if name_match != "improve":
            fail(f"check1: SKILL.md frontmatter name is {name_match!r}, expected 'improve'")
        else:
            if has_name and has_desc:
                ok("check1: SKILL.md frontmatter valid (name='improve', description present)")

# Store frontmatter name and metadata version for later checks
_skill_name = None
_skill_meta_version = None
if skill_lines[0].strip() == "---":
    close_idx2 = None
    for i, line in enumerate(skill_lines[1:], start=1):
        if line.strip() == "---":
            close_idx2 = i
            break
    if close_idx2:
        fm_lines2 = skill_lines[1:close_idx2]
        for l in fm_lines2:
            m = re.match(r"^name:\s*(.+)", l)
            if m:
                _skill_name = m.group(1).strip()
        # version is nested under metadata: as "  version: ..."
        for l in fm_lines2:
            m = re.match(r"^\s+version:\s*[\"']?([^\"'\s]+)[\"']?", l)
            if m:
                _skill_meta_version = m.group(1).strip()


# ---------------------------------------------------------------------------
# Check 2: Plugin manifest validity and name/version agreement
# ---------------------------------------------------------------------------

PLUGIN_PATH = os.path.join(REPO_ROOT, ".claude-plugin", "plugin.json")

try:
    with open(PLUGIN_PATH, encoding="utf-8") as f:
        plugin = json.load(f)
except json.JSONDecodeError as e:
    fail(f"check2: .claude-plugin/plugin.json is not valid JSON: {e}")
    plugin = None
except FileNotFoundError:
    fail("check2: .claude-plugin/plugin.json not found")
    plugin = None

if plugin is not None:
    plugin_name = plugin.get("name", "")
    plugin_version = plugin.get("version", "")

    if not plugin_name:
        fail("check2: plugin.json 'name' is empty or missing")
    if not plugin_version:
        fail("check2: plugin.json 'version' is empty or missing")

    if plugin_name and _skill_name and plugin_name != _skill_name:
        fail(
            f"check2: plugin.json name {plugin_name!r} != SKILL.md name {_skill_name!r}"
        )
    elif plugin_name and _skill_name:
        ok(f"check2: plugin.json valid, name={plugin_name!r} matches SKILL.md")
    else:
        ok("check2: plugin.json parseable with non-empty name and version")


# ---------------------------------------------------------------------------
# Check 3: Relative links resolve in all *.md files
# ---------------------------------------------------------------------------
# Skips .git/ and plans/ directories.
# Skips links inside fenced code blocks (``` ... ```).
# Strips #fragment from targets.

INLINE_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)")

link_failures = []

for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
    # Skip .git and plans directories
    dirnames[:] = [
        d for d in dirnames
        if d not in (".git", "plans")
        and not os.path.join(dirpath, d).startswith(os.path.join(REPO_ROOT, ".git"))
    ]

    for fname in filenames:
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(dirpath, fname)
        rel_fpath = os.path.relpath(fpath, REPO_ROOT)

        with open(fpath, encoding="utf-8") as f:
            lines = f.readlines()

        in_fence = False
        fence_marker = None

        for lineno, line in enumerate(lines, start=1):
            stripped = line.rstrip("\n")

            # Detect fenced code block boundaries (``` or ~~~)
            fence_match = re.match(r"^(`{3,}|~{3,})", stripped)
            if fence_match:
                marker = fence_match.group(1)[0]  # ` or ~
                if not in_fence:
                    in_fence = True
                    fence_marker = marker
                elif fence_marker == marker:
                    in_fence = False
                    fence_marker = None
                continue

            if in_fence:
                continue

            # Extract inline links
            for m in INLINE_LINK_RE.finditer(stripped):
                target = m.group(1)

                # Skip absolute URLs and mailto
                if target.startswith(("http://", "https://", "mailto:")):
                    continue

                # Resolve relative to the file's directory
                file_dir = os.path.dirname(fpath)
                resolved = os.path.normpath(os.path.join(file_dir, target))

                if not os.path.exists(resolved):
                    msg = (
                        f"check3: broken link in {rel_fpath}:{lineno}: "
                        f"{target!r} -> {os.path.relpath(resolved, REPO_ROOT)!r} not found"
                    )
                    link_failures.append(msg)
                    fail(msg)

if not link_failures:
    ok("check3: all relative links resolve")


# ---------------------------------------------------------------------------
# Check 4: Invocation variant parity between README.md and SKILL.md
# ---------------------------------------------------------------------------

VARIANTS = {"quick", "deep", "branch", "next", "plan", "review-plan", "execute", "reconcile", "--issues"}

README_PATH = os.path.join(REPO_ROOT, "README.md")

with open(README_PATH, encoding="utf-8") as f:
    readme_text = f.read()

parity_failures = []
for variant in sorted(VARIANTS):
    in_readme = variant in readme_text
    in_skill = variant in skill_text
    if not in_readme:
        msg = f"check4: variant {variant!r} missing from README.md"
        parity_failures.append(msg)
        fail(msg)
    if not in_skill:
        msg = f"check4: variant {variant!r} missing from SKILL.md"
        parity_failures.append(msg)
        fail(msg)

if not parity_failures:
    ok(f"check4: all {len(VARIANTS)} variants present in both README.md and SKILL.md")


# ---------------------------------------------------------------------------
# Check 5: version in SKILL.md metadata block equals plugin.json version
# ---------------------------------------------------------------------------

if plugin is not None and _skill_meta_version is not None:
    plugin_ver = plugin.get("version", "").strip()
    if _skill_meta_version != plugin_ver:
        fail(
            f"check5: SKILL.md metadata version {_skill_meta_version!r} != "
            f"plugin.json version {plugin_ver!r}"
        )
    else:
        ok(f"check5: version agrees: {_skill_meta_version!r}")
elif plugin is not None and _skill_meta_version is None:
    fail("check5: could not find 'version:' in SKILL.md frontmatter metadata block")
else:
    # plugin load already failed above
    pass


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if failures:
    sys.exit(1)

print("all checks passed")
