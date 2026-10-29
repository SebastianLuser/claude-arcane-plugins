# claude-arcane-plugins

[![Validate and test the mods](https://github.com/SebastianLuser/claude-arcane-plugins/actions/workflows/test.yml/badge.svg)](https://github.com/SebastianLuser/claude-arcane-plugins/actions/workflows/test.yml)

Personal Claude Code mods. They work in the terminal and in the desktop app (Code tab), on Claude Code 2.1.306 or newer.

| Plugin | What it does | Command |
|---|---|---|
| `agents-panel` | Panel of subagents: model, what each one is working on and how long it takes. No cost or token counts. Based on [savvy-progress](https://github.com/JohnnyVizz/claude-kit) (MIT). | `/agents-info` |
| `file-tree` | File tree with colored icons that highlights what Claude reads and edits. In the terminal it stays closed until asked, closes with ✕ and shrinks to a strip with ◂. Based on [filetree](https://github.com/data-goblin/claude-code-filetree) (MIT). | `/tree` |
| `idea-shelf` | Per-project idea shelf above the prompt box, to jot ideas down without interrupting Claude. | `/idea` |
| `assumption-check` | Claude logs the assumptions it makes; you mark each right or wrong, and wrong ones go back to Claude with your correction. | `/assumptions` |
| `prompt-enhancer` | Turns a rough prompt into a complete one before sending: skills to use, what to confirm first, scope and what done looks like. | `/enhance` |
| `shared-folder` | Shows what other sessions open in the same folder are doing. | `/shared` |
| `educabot-impacto` | Map of which other Educabot services are affected when you edit a migration, a contract, a handler or config. Band while editing, pane on demand. | `/impacto` |
| `educabot-deploy` | Deploy runbook for the current branch, opened by `/create-pr` or `/code-review`: how the repo applies migrations, which new env vars to load and where, and what each migration changes in its tables. | `/deploy-info` |

## Install

```bash
claude plugin marketplace add SebastianLuser/claude-arcane-plugins
claude plugin install agents-panel@claude-arcane-plugins
```

Swap `agents-panel` for any of the others. Then run `/reload-plugins` in an open session.

Mods run with your permissions and no sandbox: read them before installing.
