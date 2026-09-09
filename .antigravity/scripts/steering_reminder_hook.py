#!/usr/bin/env python3
"""
Stop hook for Antigravity: runs check_steering.py once and reminds the agent to
update steering docs if structural drift or process boundary violations are detected.
Contract:
  Input (stdin): JSON with executionNum, terminationReason, workspacePaths, etc.
  Output (stdout): JSON with decision: "stop" | "continue" (and optional "reason")
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import time

def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}

    # If already reminded once in this invocation sequence, allow stopping to avoid looping
    execution_num = data.get("executionNum", 1)
    if execution_num > 1:
        sys.stdout.write(json.dumps({"decision": "stop"}))
        return

    workspace_paths = data.get("workspacePaths") or []
    if workspace_paths:
        project_dir = workspace_paths[0]
    else:
        project_dir = os.getcwd()

    script = os.path.join(project_dir, ".antigravity", "scripts", "check_steering.py")
    if not os.path.exists(script):
        # Fallback relative to this script
        script = os.path.abspath(os.path.join(os.path.dirname(__file__), "check_steering.py"))
        if not os.path.exists(script):
            sys.stdout.write(json.dumps({"decision": "stop"}))
            return

    # Determine target directory:
    # 1. If an SDD worktree in .worktrees was actively written to in this session (via transcript), check that worktree.
    # 2. If the root workspace has active local changes, check the root workspace.
    # 3. If the root workspace is clean, check the most recently modified worktree (within last 45 mins).
    target_dir = get_target_directory(data, project_dir)

    res = subprocess.run(
        [sys.executable, script, target_dir],
        capture_output=True,
        text=True,
        cwd=target_dir,
    )

    if res.returncode != 0:
        detail = ((res.stdout or "") + (res.stderr or "")).strip()
        rel_target = os.path.relpath(target_dir, project_dir)
        target_label = f"worktree '{rel_target}'" if target_dir != project_dir else "workspace"
        sys.stdout.write(json.dumps({
            "decision": "continue",
            "reason": (
                f"Steering drift or boundary violation detected in {target_label} (yvoke SDD Phase 5). "
                "Update the relevant .antigravity/steering/*.md docs or fix illegal imports before finishing:\n\n"
                + detail
            )
        }))
        return

    sys.stdout.write(json.dumps({"decision": "stop"}))

def get_target_directory(data: dict, project_dir: str) -> str:
    worktrees_dir = os.path.join(project_dir, ".worktrees")
    if not os.path.isdir(worktrees_dir):
        return project_dir

    # 1. Check if any file was written to a worktree in the current session
    transcript_path = data.get("transcriptPath")
    if transcript_path and os.path.exists(transcript_path):
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    d = json.loads(line)
                    for tc in d.get("tool_calls", []):
                        if tc.get("name") in ("replace_file_content", "write_to_file"):
                            tf = tc.get("args", {}).get("TargetFile", "")
                            for entry in os.scandir(worktrees_dir):
                                if entry.is_dir() and entry.path in tf:
                                    return entry.path
        except Exception:
            pass

    # 2. Check if the root workspace has active local changes
    try:
        status_res = subprocess.run(
            ["git", "status", "--porcelain", "-uno"],
            capture_output=True, text=True, cwd=project_dir
        )
        if status_res.stdout.strip():
            # Root workspace has modified files; audit root
            return project_dir
    except Exception:
        pass

    # 3. If root workspace is clean, check for a recently modified worktree (within last 45 minutes)
    now = time.time()
    recent = []
    try:
        for entry in os.scandir(worktrees_dir):
            if entry.is_dir() and os.path.exists(os.path.join(entry.path, ".git")):
                if (now - os.path.getmtime(entry.path)) < 2700:
                    recent.append(entry.path)
    except Exception:
        recent = []

    if recent:
        return max(recent, key=os.path.getmtime)

    return project_dir

if __name__ == "__main__":
    main()
