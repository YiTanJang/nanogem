# NanoClaw Skills Architecture

## Core Principle

Skills are self-contained, auditable packages that apply programmatically via standard git merge mechanics. Gemini CLI orchestrates the process — running git commands, reading skill manifests, and stepping in only when git can't resolve a conflict on its own. The system uses existing git features (`merge-file`, `rerere`, `apply`) rather than custom merge infrastructure.

### The Three-Level Resolution Model

Every operation in the system follows this escalation:

1. **Git** — deterministic, programmatic. `git merge-file` merges, `git rerere` replays cached resolutions, structured operations apply without merging. No AI involved. This handles the vast majority of cases.
2. **Gemini CLI** — reads `SKILL.md`, `.intent.md`, migration guides, and `state.yaml` to understand context. Resolves conflicts that git can't handle programmatically. Caches the resolution via `git rerere` so it never needs to resolve the same conflict again.
3. **User** — Gemini CLI asks the user when it lacks context or intent. This happens when two features genuinely conflict at an application level (not just a text-level merge conflict) and a human decision is needed about desired behavior.

The goal is that Level 1 handles everything on a mature, well-tested installation. Level 2 handles first-time conflicts and edge cases. Level 3 is rare and only for genuine ambiguity.

**Important**: a clean merge (exit code 0) does not guarantee working code. Semantic conflicts — a renamed variable, a shifted reference, a changed function signature — can produce clean text merges that break at runtime. **Tests must run after every operation**, regardless of whether the merge was clean. A clean merge with failing tests escalates to Level 2.

### Safe Operations via Backup/Restore

Many users clone the repo without forking, don't commit their changes, and don't think of themselves as git users. The system must work safely for them without requiring any git knowledge.

Before any operation, the system copies all files that will be modified to `.nanoclaw/backup/`. On success, the backup is deleted. On failure, the backup is restored. This provides rollback safety regardless of whether the user commits, pushes, or understands git.

---

## 1. The Shared Base

`.nanoclaw/base/` holds the clean core — the original codebase before any skills or customizations were applied. This is the stable common ancestor for all three-way merges, and it only changes on core updates.

- `git merge-file` uses the base to compute two diffs: what the user changed (current vs base) and what the skill wants to change (base vs skill's modified file), then combines both
- The base enables drift detection: if a file's hash differs from its base hash, something has been modified (skills, user customizations, or both)
- Each skill's `modify/` files contain the full file as it should look with that skill applied (including any prerequisite skill changes), all authored against the same clean core base

On a **fresh codebase**, the user's files are identical to the base. This means `git merge-file` always exits cleanly for the first skill — the merge trivially produces the skill's modified version. No special-casing needed.

When multiple skills modify the same file, the three-way merge handles the overlap naturally. If Telegram and Discord both modify `src/index.ts`, and both skill files include the Telegram changes, those common changes merge cleanly against the base. The result is the base + all skill changes + user customizations.

---

## 2. Two Types of Changes: Code Merges vs. Structured Operations

Not all files should be merged as text. The system distinguishes between **code files** (merged via `git merge-file`) and **structured data** (modified via deterministic operations).

### Code Files (Three-Way Merge)

Source code files where skills weave in logic — route handlers, middleware, business logic. These are merged using `git merge-file` against the shared base. The skill carries a full modified version of the file.

### Structured Data (Deterministic Operations)

Files like `package.json`, `docker-compose.yml`, `.env.example`, and generated configs are not code you merge — they're structured data you aggregate. Multiple skills adding npm dependencies to `package.json` shouldn't require a three-way text merge. Instead, skills declare their structured requirements in the manifest, and the system applies them programmatically.

**Structured operations are implicit.** If a skill declares `npm_dependencies`, the system handles dependency installation automatically. There is no need for the skill author to add `npm install` to `post_apply`. When multiple skills are applied in sequence, the system batches structured operations: merge all dependency declarations first, write `package.json` once, run `npm install` once at the end.

```yaml
# In manifest.yaml
structured:
  npm_dependencies:
    whatsapp-web.js: "^2.1.0"
    qrcode-terminal: "^0.12.0"
  env_additions:
    - WHATSAPP_TOKEN
    - WHATSAPP_VERIFY_TOKEN
    - WHATSAPP_PHONE_ID
  docker_compose_services:
    whatsapp-redis:
      image: redis:alpine
      ports: ["6380:6379"]
```

### Structured Operation Conflicts

Structured operations eliminate text merge conflicts but can still conflict at a semantic level:

- **NPM version conflicts**: two skills request incompatible semver ranges for the same package
- **Port collisions**: two docker-compose services claim the same host port
- **Service name collisions**: two skills define a service with the same name
- **Env var duplicates**: two skills declare the same variable with different expectations

The resolution policy:

1. **Automatic where possible**: widen semver ranges to find a compatible version, detect and flag port/name collisions
2. **Level 2 (Gemini CLI)**: if automatic resolution fails, Gemini CLI proposes options based on skill intents
3. **Level 3 (User)**: if it's a genuine product choice, ask the user

Structured operation conflicts are included in the CI overlap graph alongside code file overlaps, so the maintainer test matrix catches these before users encounter them.

### State Records Structured Outcomes

`state.yaml` records not just the declared dependencies but the resolved outcomes — actual installed versions, resolved port assignments, final env var list. This makes structured operations replayable and auditable.

### Deterministic Serialization

All structured output (YAML, JSON) uses stable serialization: sorted keys, consistent quoting, normalized whitespace. This prevents noisy diffs in git history from non-functional formatting changes.

---

## 3. Skill Package Structure

A skill contains only the files it adds or modifies. For modified code files, the skill carries the **full modified file** (the clean core with the skill's changes applied).

```
skills/
  add-whatsapp/
    SKILL.md                          # Context, intent, what this skill does and why
    manifest.yaml                     # Metadata, dependencies, env vars, post-apply steps
    tests/                            # Integration tests for this skill
      whatsapp.test.ts
    add/                              # New files — copied directly
      src/channels/whatsapp.ts
      src/channels/whatsapp.config.ts
    modify/                           # Modified code files — merged via git merge-file
      src/
        server.ts                     # Full file: clean core + whatsapp changes
        server.ts.intent.md           # "Adds WhatsApp webhook route and message handler"
        config.ts                     # Full file: clean core + whatsapp config options
        config.ts.intent.md           # "Adds WhatsApp channel configuration block"
```

### Why Full Modified Files

- `git merge-file` requires three full files — no intermediate reconstruction step
- Git's three-way merge uses context matching, so it works even if the user has moved code around — unlike line-number-based diffs that break immediately
- Auditable: `diff .nanoclaw/base/src/server.ts skills/add-whatsapp/modify/src/server.ts` shows exactly what the skill changes
- Deterministic: same three inputs always produce the same merge result
- Size is negligible since NanoClaw's core files are small

### Intent Files

Each modified code file has a corresponding `.intent.md` with structured headings:

```markdown
# Intent: server.ts modifications

## What this skill adds
Adds WhatsApp webhook route and message handler to the Express server.

## Key sections
- Route registration at `/webhook/whatsapp` (POST and GET for verification)
- Message handler middleware between auth and response pipeline

## Invariants
- Must not interfere with other channel webhook routes
- Auth middleware must run before the WhatsApp handler
- Error handling must propagate to the global error handler

## Must-keep sections
- The webhook verification flow (GET route) is required by WhatsApp Cloud API
```

Structured headings (What, Key sections, Invariants, Must-keep) give Gemini CLI specific guidance during conflict resolution instead of requiring it to infer from unstructured text.

### Manifest Format

```yaml
# --- Required fields ---
skill: whatsapp
version: 1.2.0
description: "WhatsApp Business API integration via Cloud API"
core_version: 0.1.0               # The core version this skill was authored against

# Files this skill adds
adds:
  - src/channels/whatsapp.ts
  - src/channels/whatsapp.config.ts

# Code files this skill modifies (three-way merge)
modifies:
  - src/server.ts
  - src/config.ts

# File operations (renames, deletes, moves — see Section 5)
file_ops: []

# Structured operations (deterministic, no merge — implicit handling)
structured:
  npm_dependencies:
    whatsapp-web.js: "^2.1.0"
    qrcode-terminal: "^0.12.0"
  env_additions:
    - WHATSAPP_TOKEN
    - WHATSAPP_VERIFY_TOKEN
    - WHATSAPP_PHONE_ID

# Skill relationships
conflicts: []              # Skills that cannot coexist without agent resolution
depends: []                # Skills that must be applied first

# Test command — runs after apply to validate the skill works
test: "npx vitest run src/channels/whatsapp.test.ts"

# --- Future fields (not yet implemented in v0.1) ---
# author: nanoclaw-team
# license: MIT
# min_skills_system_version: "0.1.0"
# tested_with: [telegram@1.0.0]
# post_apply: []
```

Note: `post_apply` is only for operations that can't be expressed as structured declarations. Dependency installation is **never** in `post_apply` — it's handled implicitly by the structured operations system.

---

## 4. Skills, Customization, and Layering

### One Skill, One Happy Path

A skill implements **one way of doing something — the reasonable default that covers 80% of users.** `add-telegram` gives you a clean, solid Telegram integration. It doesn't try to anticipate every use case with predefined configuration options and modes.

### Customization Is Just More Patching

The entire system is built around applying transformations to a codebase. Customizing a skill after applying it is no different from any other modification:

- **Apply the skill** — get the standard Telegram integration
- **Modify from there** — using the customize flow (tracked patch), direct editing (detected by hash tracking), or by applying additional skills that build on top

### Layered Skills

Skills can build on other skills:

```
add-telegram                    # Core Telegram integration (happy path)
  ├── telegram-reactions        # Adds reaction handling (depends: [telegram])
  ├── telegram-multi-bot        # Multiple bot instances (depends: [telegram])
  └── telegram-filters          # Custom message filtering (depends: [telegram])
```

Each layer is a separate skill with its own `SKILL.md`, manifest (with `depends: [telegram]`), tests, and modified files. The user composes exactly what they want by stacking skills.

### Custom Skill Application

A user can apply a skill with their own modifications in a single step:

1. Apply the skill normally (programmatic merge)
2. Gemini CLI asks if the user wants to make any modifications
3. User describes what they want different
4. Gemini CLI makes the modifications on top of the freshly applied skill
5. The modifications are recorded as a custom patch tied to this skill

Recorded in `state.yaml`:

```yaml
applied_skills:
  - skill: telegram
    version: 1.0.0
    custom_patch: .nanoclaw/custom/telegram-group-only.patch
    custom_patch_description: "Restrict bot responses to group chats only"
```

On replay, the skill applies programmatically, then the custom patch applies on top.

---

## 5. File Operations: Renames, Deletes, Moves

Core updates and some skills will need to rename, delete, or move files. These are not text merges — they're structural changes handled as explicit scripted operations.

### Execution Order

File operations run **before** code merges, because merges need to target the correct file paths:

1. Pre-flight checks (state validation, core version, dependencies, conflicts, drift detection)
2. Acquire operation lock
3. **Backup** all files that will be touched
4. **File operations** (renames, deletes, moves)
5. Copy new files from `add/`
6. Three-way merge modified code files
7. Conflict resolution (rerere auto-resolve, or return with `backupPending: true`)
8. Apply structured operations (npm deps, env vars, docker-compose — batched)
9. Run `npm install` (once, if any structured npm_dependencies exist)
10. Update state (record skill application, file hashes, structured outcomes)
11. Run tests (if `manifest.test` defined; rollback state + backup on failure)
12. Clean up (delete backup on success, release lock)

### Path Remapping for Skills

When the core renames a file (e.g., `server.ts` → `app.ts`), skills authored against the old path still reference `server.ts` in their `modifies` and `modify/` directories. **Skill packages are never mutated on the user's machine.**

Instead, core updates ship a **compatibility map**:

```yaml
# In the update package
path_remap:
  src/server.ts: src/app.ts
  src/old-config.ts: src/config/main.ts
```

The system resolves paths at apply time: if a skill targets `src/server.ts` and the remap says it's now `src/app.ts`, the merge runs against `src/app.ts`. The remap is recorded in `state.yaml` so future operations are consistent.

---

## 6. The Apply Flow

When a user runs the skill's slash command in Gemini CLI:

### Step 1: Pre-flight Checks

- Core version compatibility
- Dependencies satisfied
- No unresolvable conflicts with applied skills
- Check for untracked changes (see Section 9)

### Step 2: Backup

Copy all files that will be modified to `.nanoclaw/backup/`. If the operation fails at any point, restore from backup.

### Step 3: File Operations

Execute renames, deletes, or moves with safety checks. Apply path remapping if needed.

### Step 4: Apply New Files

```bash
cp skills/add-whatsapp/add/src/channels/whatsapp.ts src/channels/whatsapp.ts
```

### Step 5: Merge Modified Code Files

For each file in `modifies` (with path remapping applied):

```bash
git merge-file src/server.ts .nanoclaw/base/src/server.ts skills/add-whatsapp/modify/src/server.ts
```

- **Exit code 0**: clean merge, move on
- **Exit code > 0**: conflict markers in file, proceed to resolution

### Step 6: Conflict Resolution (Three-Level)

1. **Check shared resolution cache** (`.nanoclaw/resolutions/`) — load into local `git rerere` if a verified resolution exists for this skill combination. **Only apply if input hashes match exactly** (base hash + current hash + skill modified hash).
2. **`git rerere`** — checks local cache. If found, applied automatically. Done.
3. **Gemini CLI** — reads conflict markers + `SKILL.md` + `.intent.md` (Invariants, Must-keep sections) of current and previously applied skills. Resolves. `git rerere` caches the resolution.
4. **User** — if Gemini CLI cannot determine intent, it asks the user for the desired behavior.

### Step 7: Apply Structured Operations

Collect all structured declarations (from this skill and any previously applied skills if batching). Apply deterministically:

- Merge npm dependencies into `package.json` (check for version conflicts)
- Append env vars to `.env.example`
- Merge docker-compose services (check for port/name collisions)
- Run `npm install` **once** at the end
- Record resolved outcomes in state

### Step 8: Post-Apply and Validate

1. Run any `post_apply` commands (non-structured operations only)
2. Update `.nanoclaw/state.yaml` — skill record, file hashes (base, skill, merged per file), structured outcomes
3. **Run skill tests** — mandatory, even if all merges were clean
4. If tests fail on a clean merge → escalate to Level 2 (Gemini CLI diagnoses the semantic conflict)

### Step 9: Clean Up

If tests pass, delete `.nanoclaw/backup/`. The operation is complete.

If tests fail and Level 2 can't resolve, restore from `.nanoclaw/backup/` and report the failure.

---

## 7. Shared Resolution Cache

### The Problem

`git rerere` is local by default. But NanoClaw has thousands of users applying the same skill combinations. Every user hitting the same conflict and waiting for Gemini CLI to resolve it is wasteful.

### The Solution

NanoClaw maintains a verified resolution cache in `.nanoclaw/resolutions/` that ships with the project. This is the shared artifact — **not** `.git/rr-cache/`, which stays local.

#### Implication: Git Repository Required

The adapter requires `git hash-object`, `git update-index`, and `.git/rr-cache/`. This means the project directory must be a git repository for rerere caching to work. Users who download a zip (no `.git/`) lose resolution caching but not functionality — conflicts escalate directly to Level 2 (Gemini CLI resolves). The system should detect this case and skip rerere operations gracefully.

---

## 8. State Tracking

`.nanoclaw/state.yaml` records everything about the installation.

---

## 9. Untracked Changes

If a user edits files directly, the system detects this via hash comparison.

### When Detection Happens

Before **any operation that modifies the codebase**: applying a skill, removing a skill, updating the core, replaying, or rebasing.

### What Happens

```
Detected untracked changes to src/server.ts.
[1] Record these as a custom modification (recommended)
[2] Continue anyway (changes preserved, but not tracked for future replay)
[3] Abort
```

### The Recovery Guarantee

No matter how much a user modifies their codebase outside the system, the three-level model can always bring them back:

1. **Git**: diff current files against base, identify what changed
2. **Gemini CLI**: read `state.yaml` to understand what skills were applied, compare against actual file state, identify discrepancies
3. **User**: Gemini CLI asks what they intended, what to keep, what to discard

There is no unrecoverable state.

---

## 10. Core Updates

Core updates must be as programmatic as possible. The NanoClaw team is responsible for ensuring updates apply cleanly to common skill combinations.

### How Migrations Work During Updates

1. Three-way merge brings in everything from the new core — patches, breaking changes, all of it
2. Conflict resolution (normal)
3. Re-apply custom patches (normal)
4. **Update base to new core**
5. Filter `migrations.yaml` for entries where `since` > user's old `core_version`
6. **Apply each migration skill using the normal apply flow against the new base**
7. Record migration skills in `state.yaml` like any other skill
8. Run tests

Step 6 is just the same apply function used for any skill.

### What the User Sees

```
Core updated: 0.5.0 → 0.8.0
  ✓ All patches applied

  Preserving your current setup:
    + apple-containers@1.0.0
    + add-whatsapp@2.0.0
    + legacy-auth@1.0.0

  Skill updates:
    ✓ add-telegram 1.0.0 → 1.2.0

  To accept new defaults: /remove-skill <name>
  ✓ All tests passing
```

### Update Flow (Full)

#### Step 6: Conflict Resolution

1. Shipped resolutions (hash-verified) → automatic
2. `git rerere` local cache → automatic
3. Gemini CLI with `migration.md` + skill intents → resolves
4. User → only for genuine ambiguity

---

## 11. Skill Removal (Uninstall)

Removing a skill is not a reverse-patch operation. **Uninstall is a replay without the skill.**

---

## 13. Replay

Given `state.yaml`, reproduce the exact installation on a fresh machine with no AI intervention (assuming all resolutions are cached).

---

## 17. Design Principles

1. **Use git, don't reinvent it.**
2. **Three-level resolution: git → Gemini CLI → user.** Programmatic first, AI second, human third.
3. **Clean merges aren't enough.** Tests run after every operation.
4. **All operations are safe.** Backup before, restore on failure.
5. **One shared base.** `.nanoclaw/base/` is the clean core before any skills or customizations.
6. **Code merges vs. structured operations.** Source code is three-way merged. Dependencies, env vars, and configs are aggregated programmatically.
7. **Resolutions are learned and shared.** Maintainers resolve conflicts and ship verified resolutions with hash enforcement.
8. **One skill, one happy path.** Customization is more patching.
9. **Skills layer and compose.**
10. **Intent is first-class and structured.**
11. **State is explicit and complete.** Replay is deterministic.
12. **Always recoverable.**
13. **Uninstall is replay.**
14. **Core updates are the maintainers' responsibility.** Breaking changes require a migration skill.
15. **File operations and path remapping are first-class.**
16. **Skills are tested.** Tests run always.
17. **Deterministic serialization.**
18. **Rebase when needed.**
19. **Progressive core slimming.**
