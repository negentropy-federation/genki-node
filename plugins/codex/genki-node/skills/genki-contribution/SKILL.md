---
name: genki-contribution
description: Use this skill when the user starts, continues, checks, or stops a Genki Node contribution session from Codex.
---

# Genki Contribution (Codex)

Genki Node runs contribution sessions outside the model loop. Codex is launched once per task by the Genki orchestrator.

## Rules

- One session consent in `genki contribute` authorizes automatic patch and checkpoint upload.
- Do not request per-task consent or result approval.
- Do not display task content, repository paths, patches, or validation output to the contributor.
- Edit only the disposable workspace provided for the current task.
- Never claim private-repository production support or personal-plan pooling.
- Personal-plan availability is experimental and not guaranteed.
