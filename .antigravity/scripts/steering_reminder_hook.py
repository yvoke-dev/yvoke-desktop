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

    res = subprocess.run(
        [sys.executable, script, project_dir],
        capture_output=True,
        text=True,
        cwd=project_dir,
    )

    if res.returncode != 0:
        detail = ((res.stdout or "") + (res.stderr or "")).strip()
        sys.stdout.write(json.dumps({
            "decision": "continue",
            "reason": (
                "Steering drift or boundary violation detected in workspace (yvoke SDD Phase 5). "
                "Update the relevant .antigravity/steering/*.md docs or fix illegal imports before finishing:\n\n"
                + detail
            )
        }))
        return

    sys.stdout.write(json.dumps({"decision": "stop"}))

if __name__ == "__main__":
    main()
