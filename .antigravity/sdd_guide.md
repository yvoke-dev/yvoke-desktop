# ASDD Guide: Spec-Driven Development on Antigravity 2.0 (Electron + React + TypeScript)

This guide outlines how to execute the **Antigravity Spec-Driven Development (ASDD)** flow, specifically adapted for building and maintaining `yvoke-desktop`.

Under ASDD on Antigravity 2.0, the codebase remains entirely clean of design files, checklists, and specifications. All specifications are maintained natively inside Antigravity's chat memory and native Planning Mode directory (`<appDataDir>/brain/<conversation-id>/`).

---

## 🏃 Step-by-Step Execution Tutorial

### Phase 1: Discovery & Requirements
When initiating a feature, the parent agent takes time to fully understand the goal:
1. **Clarify & Grill**: The parent agent grills the developer on details, edge cases, and any aspects that are unclear or ambiguous.
2. **Research Options**: The parent agent researches 2-3 different ways of implementing the feature.
3. **Compare & Recommend**: The parent agent outlines the pros and cons of each approach and makes a formal recommendation.
Once the developer aligns on the recommended approach and gives approval, the parent agent enters the design phase.

#### 📝 Example Requirements: Chat Thread Storage
* **Functional Requirements**:
  - Store thread metadata and message logs locally.
  - Implement a thread list sidebar in `src/renderer/src/components/ThreadList.tsx`.
  - Expose main-process `ThreadStore` methods via IPC contextBridge in `src/preload/index.ts`.

---

### Phase 2: Design & Implementation Plan
The Parent Agent enters **Planning Mode** natively, creating `implementation_plan.md` in its native brain folder (`<appDataDir>/brain/<conversation-id>/implementation_plan.md`) as a native interactive artifact to solicit user review and approval.

#### 📝 Example Plan Structure:
* **Proposed Changes**: Detail files to modify or create (e.g. `AppCore.ts`, renderer component, preload script).
* **Correctness Properties**: Invariants such as IPC parameter validation, React component lifecycle cleanups, and TypeScript type safety.
* **Verification Plan**: Exact commands to verify the feature (e.g., `npm test`, `npm run typecheck`).

Once approved by the user (clicking "Proceed"), the agent transitions to the task checklist.

---

### Phase 3: Task Checklist & Wave Breakdown
The Parent Agent creates a `task.md` wave-based checklist inside its native brain directory to structure the execution waves:
* **Wave 0**: Core State & Storage (implementing database/store methods in `src/main/store/`).
* **Wave 1**: Preload Bridge & IPC Wiring (wiring contextBridge in `src/preload/` and IPC handlers in `src/main/`).
* **Wave 2**: React UI Assembly, styles.css updates, and final review task.

The checklist is rendered in the interactive chat UI.

---

### Phase 4: Local Subagent Execution & Code Review
To implement the approved waves, the Parent Agent defines and spawns specialized subagents in `inherit` workspace mode to edit the local files directly.

#### 1. Implementer Subagent Execution
The Parent Agent defines `desktop_implementer` (based on the role spec in `.antigravity/agents/desktop_implementer.md`) and invokes it to write code and verify unit/integration tests in the local workspace.
* The implementer modifies local files directly, without committing.
* The implementer reports completion to the Parent Agent, who then marks the tasks as completed (`[x]`) natively in `task.md`.

#### 2. Reviewer Subagent Audit & Remediation Loop
Once the implementer finishes, the Parent Agent defines and invokes `desktop_reviewer` (based on `.antigravity/agents/desktop_reviewer.md`):
* The reviewer inspects uncommitted changes for Electron multi-process security (e.g., IPC param validation, preload API isolation), React memory leaks (IPC listeners cleanup), type safety, performance, and compliance with correctness properties.
* If findings are detected, the implementer is spawned again to fix them.
* Once clean, the reviewer reports completion, and the Parent Agent marks the audit task as complete.

---

### Phase 5: Verification, Walkthrough & Ship
Once execution completes:
1. The Parent Agent runs typescript typechecking across both Node and Web targets via `npm run typecheck`.
2. The Parent Agent runs `python3 .antigravity/scripts/check_steering.py` on the uncommitted workspace. This script enforces Electron architectural boundaries (preventing illegal imports across main, preload, and renderer layers).
3. The Parent Agent compiles a `walkthrough.md` in its native brain folder, presenting the testing logs, verification results, and the uncommitted diff.
4. The Parent Agent reports completion.
5. **The user reviews the uncommitted changes in their IDE and commits them manually.**
