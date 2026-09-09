#!/usr/bin/env python3
"""
PreToolUse hook for Antigravity: blocks unintended modification of release and signing scripts.
Contract:
  Input (stdin): JSON with toolCall: { name: str, args: { TargetFile: str, ... } }
  Output (stdout): JSON with decision: "allow" | "deny" (and optional "reason")
"""
from __future__ import annotations
import json
import os
import re
import sys

def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            sys.stdout.write(json.dumps({"decision": "allow"}))
            return
        data = json.loads(raw)
    except Exception:
        sys.stdout.write(json.dumps({"decision": "allow"}))
        return

    tool_call = data.get("toolCall") or data.get("tool_call") or {}
    tool_name = tool_call.get("name") or data.get("tool_name", "")
    args = tool_call.get("args") or data.get("tool_input", {})

    # Check shell commands
    if tool_name == "run_command" or "CommandLine" in args or "commandLine" in args:
        cmd = args.get("CommandLine") or args.get("commandLine") or args.get("command") or ""
        cmd_reason = check_command(cmd)
        if cmd_reason:
            deny_command(cmd, cmd_reason)
            return

    # Extract target file from arguments
    target_file = (
        args.get("TargetFile")
        or args.get("targetFile")
        or args.get("file_path")
        or ""
    )

    if not target_file and isinstance(args.get("files"), list):
        # Multi-file edits
        for f in args["files"]:
            p = f.get("TargetFile") or f.get("targetFile") or ""
            if is_protected(p):
                deny(p)
                return

    if is_protected(target_file):
        deny(target_file)
        return

    sys.stdout.write(json.dumps({"decision": "allow"}))

def is_protected(file_path: str) -> bool:
    if not file_path:
        return False
    norm = file_path.replace("\\", "/")
    return bool(re.search(r"scripts/(release.*|check-signing-cert)\.sh$", norm))

def check_command(cmd: str):
    if not cmd:
        return None
    cmd_clean = cmd.strip()

    # 1. Block direct release script execution
    if re.search(r"\bnpm\s+run\s+release\b", cmd_clean):
        return "Executing 'npm run release' is forbidden during regular agent workflows. Releases are cut strictly by human engineers."

    if re.search(r"(?:bash|sh|zsh|\./|\bexec\b)?\s*.*scripts/(?:release.*|check-signing-cert)\.sh\b", cmd_clean):
        read_only_prefix = re.match(r"^(?:cat|head|tail|grep|rg|ls|file)\b", cmd_clean)
        if not read_only_prefix:
            return "Invoking release or signing scripts directly is forbidden during regular agent workflows."

    # 2. Block manual git tag creation or deletion
    if re.search(r"\bgit\s+tag\b", cmd_clean):
        is_list = bool(re.search(r"^\s*git\s+tag\s*$", cmd_clean) or re.search(r"^\s*git\s+tag\s+(?:-l|--list|-n\d*)(?:\s+[\"']?[*a-zA-Z0-9._-]+[\"']?)?\s*$", cmd_clean))
        if not is_list:
            return "Manual creation, modification, or deletion of git tags is strictly forbidden. Releases and tags are managed exclusively via 'npm run release'."

    # 3. Block pushing git tags
    if re.search(r"\bgit\s+push\b.*(?:--tags|refs/tags/|\bv\d+\.\d+)", cmd_clean):
        return "Pushing git release tags is strictly forbidden."

    # 4. Block destructive shell operations on protected scripts
    if re.search(r"\b(?:rm|mv|cp|truncate|sed)\b.*scripts/(?:release.*|check-signing-cert)\.sh", cmd_clean) or \
       re.search(r">\s*.*scripts/(?:release.*|check-signing-cert)\.sh", cmd_clean):
        return "Mutating or deleting protected release/signing scripts via shell commands is strictly forbidden."

    return None

def deny(file_path: str):
    sys.stdout.write(json.dumps({
        "decision": "deny",
        "reason": (
            f"BLOCKED: '{file_path}' is a protected release/signing script. "
            "Release scripts must not be modified during regular feature development."
        )
    }))

def deny_command(cmd: str, reason: str):
    sys.stdout.write(json.dumps({
        "decision": "deny",
        "reason": f"BLOCKED: {reason} (Command: '{cmd}')"
    }))

if __name__ == "__main__":
    main()
