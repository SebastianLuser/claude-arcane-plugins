# claude-arcane-plugins

Personal Claude Code mods. They work in the terminal and in the desktop app (Code tab), on Claude Code 2.1.306 or newer.

| Plugin | What it does | Command |
|---|---|---|
| `agents-panel` | Panel of subagents: model, what each one is working on and how long it takes. Spanish UI, no cost or token counts. Based on [savvy-progress](https://github.com/JohnnyVizz/claude-kit) (MIT). | `/agents-info` |
| `file-tree` | File tree with colored icons that highlights what Claude reads and edits. In the terminal it stays closed until asked, closes with ✕ and shrinks to a strip with ◂. Based on [filetree](https://github.com/data-goblin/claude-code-filetree) (MIT). | `/arbol` |
| `idea-shelf` | Per-project idea shelf above the prompt box, to jot ideas down without interrupting Claude. | `/idea` |
| `assumption-check` | Claude logs the assumptions it makes; you mark each right or wrong, and wrong ones go back to Claude with your correction. | `/supuestos` |
| `prompt-enhancer` | Turns a rough prompt into a complete one before sending: skills to use, what to confirm first, scope and what done looks like. | `/mejorar` |
| `shared-folder` | Shows what other sessions open in the same folder are doing. | `/compartida` |

## Install

```bash
claude plugin marketplace add SebastianLuser/claude-arcane-plugins
claude plugin install agents-panel@claude-arcane-plugins
```

Swap `agents-panel` for any of the others. Then run `/reload-plugins` in an open session.

Mods run with your permissions and no sandbox: read them before installing.
