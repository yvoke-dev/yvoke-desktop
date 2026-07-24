#!/usr/bin/env python3
# .antigravity/scripts/check_steering.py
# Verifies if structural codebase changes occurred that require updating steering docs
# and enforces Electron architectural boundaries.

import os
import subprocess
import re
import sys

def get_git_changes():
    # Check if we have HEAD (non-empty repository check)
    has_head = subprocess.run(["git", "rev-parse", "HEAD"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not has_head:
        # Brand new repo, compare status
        res = subprocess.run(["git", "status", "--porcelain", "-uall"], capture_output=True, text=True)
        changed = []
        for line in res.stdout.splitlines():
            if not line:
                continue
            path = line[3:].strip()
            # Handle renamed files (e.g. R  old_path -> new_path)
            if ('R' in line[:2]) and ' -> ' in path:
                path = path.split(' -> ')[1].strip()
            changed.append(path)
        return changed
        
    # Get tracked modified & staged changes
    res_diff = subprocess.run(["git", "diff", "--name-only", "HEAD"], capture_output=True, text=True)
    tracked_changes = [line.strip() for line in res_diff.stdout.splitlines() if line]

    # Get untracked files
    res_untracked = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], capture_output=True, text=True)
    untracked_changes = [line.strip() for line in res_untracked.stdout.splitlines() if line]

    return list(set(tracked_changes + untracked_changes))

def get_documented_paths(structure_content):
    lines = structure_content.splitlines()
    start_idx = -1
    for i, line in enumerate(lines):
        if "src/" in line:
            start_idx = i
            break
    if start_idx == -1:
        return set()
        
    start_line = lines[start_idx]
    start_indent_str = start_line.replace('│', ' ')
    m_start = re.search(r'([a-zA-Z0-9_\-]+)/', start_line)
    if not m_start:
        return set()
    start_folder = m_start.group(1)
    start_indent = len(start_indent_str.split(start_folder + '/')[0])

    documented = set()
    stack = []  # list of tuples: (indent_level, name)
    
    for line in lines[start_idx:]:
        # Stop if we hit another header
        if line.startswith("#") and start_idx != lines.index(line):
            break
            
        if not line.strip() or ('/' not in line and not any(line.endswith(ext) or ext+' ' in line for ext in ['.ts', '.tsx', '.html', '.css'])):
            continue
            
        indent_str = line.replace('│', ' ')
        # Find folder or file name
        m_folder = re.search(r'([a-zA-Z0-9_\.\-]+)/', line)
        m_file = re.search(r'([a-zA-Z0-9_\.\-]+\.(?:tsx|ts|html|css))', line)
        
        if m_folder:
            name = m_folder.group(1)
            is_dir = True
        elif m_file:
            name = m_file.group(1)
            is_dir = False
        else:
            continue
            
        # Calculate indent up to the name
        indent = len(indent_str.split(name)[0])
        
        # If this is the root src/ folder itself, push it to stack and continue
        if name == 'src' and not stack:
            stack.append((indent, 'src'))
            documented.add('src')
            continue
            
        # Stop if we exit the src sub-hierarchy
        if indent <= start_indent and stack:
            break
            
        while stack and stack[-1][0] >= indent:
            stack.pop()
            
        if not stack:
            continue
            
        stack.append((indent, name))
        
        # Reconstruct path
        full_path = "/".join([item[1] for item in stack])
        documented.add(full_path)
        
    return documented

def check_import_boundaries(file_path, repo_root):
    if not (file_path.endswith('.ts') or file_path.endswith('.tsx')):
        return []

    errors = []
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        return [f"Could not read {file_path} for import check: {e}"]

    # Determine process layer of importing file
    if file_path.startswith('src/renderer/'):
        importer_layer = 'renderer'
    elif file_path.startswith('src/preload/'):
        importer_layer = 'preload'
    elif file_path.startswith('src/main/'):
        importer_layer = 'main'
    else:
        return []

    # Find import/require matches, ignoring 'import type'
    import_regex = re.compile(
        r'(?:import\s+type\s+.*?from\s+[\'"]([^\'\"]+)[\'"])|'
        r'(?:import\s+.*?from\s+[\'"]([^\'\"]+)[\'"])|'
        r'(?:import\s+[\'"]([^\'\"]+)[\'"])|'
        r'(?:require\(\s*[\'"]([^\'\"]+)[\'"]\))',
        re.DOTALL
    )
    
    for match in import_regex.finditer(content):
        # If the first group matches, it is an 'import type' statement. We ignore it.
        if match.group(1):
            continue
            
        target = match.group(2) or match.group(3) or match.group(4)
        if not target:
            continue
            
        if target.startswith('.'):
            # Resolve relative import
            abs_target = os.path.normpath(os.path.join(os.path.dirname(file_path), target))
            rel_target = os.path.relpath(abs_target, repo_root)

            # Check boundaries
            if importer_layer == 'renderer':
                if rel_target.startswith('src/main/') or rel_target.startswith('src/main'):
                    errors.append(f"Illegal import in renderer: '{target}' resolves to main process '{rel_target}'")
                elif rel_target.startswith('src/preload/') or rel_target.startswith('src/preload'):
                    errors.append(f"Illegal import in renderer: '{target}' resolves to preload bridge '{rel_target}'")
            elif importer_layer == 'preload':
                if rel_target.startswith('src/main/') or rel_target.startswith('src/main'):
                    errors.append(f"Illegal import in preload: '{target}' resolves to main process '{rel_target}'")
                elif rel_target.startswith('src/renderer/') or rel_target.startswith('src/renderer'):
                    errors.append(f"Illegal import in preload: '{target}' resolves to renderer process '{rel_target}'")
            elif importer_layer == 'main':
                if rel_target.startswith('src/renderer/') or rel_target.startswith('src/renderer'):
                    errors.append(f"Illegal import in main: '{target}' resolves to renderer process '{rel_target}'")
                elif rel_target.startswith('src/preload/') or rel_target.startswith('src/preload'):
                    errors.append(f"Illegal import in main: '{target}' resolves to preload bridge '{rel_target}'")


    return errors

def main():
    print("🔍 Checking for structural changes and boundary violations...")
    
    # Normalize working directory to repo root
    script_dir = os.path.dirname(os.path.realpath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "../.."))
    os.chdir(repo_root)
    
    try:
        changes = get_git_changes()
    except Exception as e:
        print(f"❌ Error getting git changes: {e}")
        sys.exit(1)
        
    config_changes = []
    structure_errors = []
    boundary_errors = []
    
    # 1. Check direct configuration files
    config_pattern = re.compile(
        r'(package\.json|tsconfig.*\.json|electron\.vite\.config\.ts|vitest\.config\.ts|electron-builder\.yml)',
        re.IGNORECASE
    )
    for file in changes:
        if config_pattern.search(file):
            config_changes.append(file)

    # 2. Check process import boundaries
    for file in changes:
        if os.path.exists(file):
            import_errors = check_import_boundaries(file, repo_root)
            for err in import_errors:
                boundary_errors.append(f"{file}: {err}")

    if boundary_errors:
        print("❌ ERROR: Electron architectural boundary violations found:")
        for err in boundary_errors:
            print(f" - {err}")
        print("\nPlease fix these illegal cross-process imports to avoid runtime failures.")
        sys.exit(2)
            
    # 3. Path validations (undocumented & obsolete)
    struct_file = ".antigravity/steering/structure.md"
    if os.path.exists(struct_file):
        with open(struct_file, "r") as f:
            struct_content = f.read()
        documented = get_documented_paths(struct_content)
        
        # Check for new files/folders under src/ not documented
        src_files = [
            f for f in changes 
            if f.startswith("src/") and os.path.exists(f)
        ]
        
        undocumented = set()
        for file in src_files:
            # Check if file itself or any of its parent directories are documented
            path_parts = file.split('/')
            found = False
            for i in range(1, len(path_parts) + 1):
                subpath = "/".join(path_parts[:i])
                if subpath in documented:
                    found = True
                    break
            if not found:
                undocumented.add(file)
                
        for path in sorted(undocumented):
            structure_errors.append(f"Undocumented path: {path}")
            
        # Check for documented paths that no longer exist in the workspace
        for doc_path in sorted(documented):
            if doc_path == 'src':
                continue
            if not os.path.exists(doc_path):
                structure_errors.append(f"Obsolete/Deleted path in structure.md: {doc_path}")
    else:
        print(f"⚠️  Warning: {struct_file} not found. Cannot verify structure.")

    # Structure errors are hard failures that must always block verification
    if structure_errors:
        print("❌ ERROR: The following structure documentation mismatches were found:")
        for err in structure_errors:
            print(f" - {err}")
        print("\nPlease update '.antigravity/steering/structure.md' to align with the codebase.")
        sys.exit(2)

    # Configuration changes require at least one steering file to be updated
    if config_changes:
        steering_updated = any(f.startswith(".antigravity/steering/") for f in changes)
        if steering_updated:
            print("✅ Configuration changes detected, and steering documents under .antigravity/steering/ have been updated.")
            print("Verification successful.")
            sys.exit(0)
        else:
            print("⚠️  WARNING: The following structural files or configuration settings have changed:")
            for change in config_changes:
                print(f" - {change}")
            print("")
            print("Please ensure you update the corresponding steering documents under .antigravity/steering/:")
            print(" - For dependencies or TS config -> update 'tech.md'")
            print(" - For directory structure modifications -> update 'structure.md'")
            print("")
            print("This check prevents context drift and ensures future agent runs start with perfect codebase alignment.")
            sys.exit(2)
    else:
        print("✅ No structural files changed. Steering documents are aligned.")
        sys.exit(0)

if __name__ == "__main__":
    main()
