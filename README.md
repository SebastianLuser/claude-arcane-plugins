# claude-arcane-plugins

Mods personales de Claude Code. Funcionan en la terminal y en la app de escritorio (Code), con Claude Code 2.1.306 o más nuevo.

| Plugin | Qué hace | Comando |
|---|---|---|
| `agents-panel` | Panel con los subagentes: modelo, en qué trabajan y cuánto tardan. En español, sin costo ni tokens. Basado en [savvy-progress](https://github.com/JohnnyVizz/claude-kit) (MIT). | `/agents-info` |
| `file-tree` | Árbol de archivos con íconos de colores que marca qué lee y modifica Claude. En la terminal no se abre solo y se cierra con ✕ o se achica con ◂. Basado en [filetree](https://github.com/data-goblin/claude-code-filetree) (MIT). | `/arbol` |
| `idea-shelf` | Estante de ideas por proyecto arriba del cuadro de texto, para anotar sin interrumpir a Claude. | `/idea` |
| `assumption-check` | Claude anota sus suposiciones; las marcás bien o mal y las mal vuelven con tu corrección. | `/supuestos` |
| `prompt-enhancer` | Mejora un pedido simple antes de enviarlo: skills a usar, qué confirmar, alcance y cómo se ve terminado. | `/mejorar` |
| `shared-folder` | Muestra qué hacen otras sesiones abiertas en la misma carpeta. | `/compartida` |

## Instalar

```bash
claude plugin marketplace add SebastianLuser/claude-arcane-plugins
claude plugin install agents-panel@claude-arcane-plugins
```

Cambiá `agents-panel` por cualquiera de los otros. Después, en una sesión abierta, `/reload-plugins`.

Los mods corren con tus permisos y sin aislamiento: leelos antes de instalarlos.
