# Architecture history

How [ARCHITECTURE.md](../ARCHITECTURE.md) was made. Two designers each wrote a full design from SPEC.md and GLOSSARY.md without seeing each other's work (round 0). Then they argued for three rounds. In each round, each designer critiqued the other's latest design, revised its own, and listed the points it still disagreed on. Both lists were still non-empty after round 3, which is the cap. A third agent then settled the remaining points and wrote the final architecture. The settler saw the two round-3 designs as Design A and Design B, along with their round-3 disagreement lists.

| File | What it is |
|---|---|
| `round-0-design-a.md`, `round-0-design-b.md` | The two first designs |
| `round-N-critique-of-b-by-a.md`, `round-N-critique-of-a-by-b.md` | Each side's critique of the other's design in round N |
| `round-N-design-a.md`, `round-N-design-b.md` | Each side's revised design after round N |
| `round-N-disagreements-a.md`, `round-N-disagreements-b.md` | The points each side still disagreed on after round N |
| `settler-note.md` | How the settler decided each disagreement |

These files are history only. ARCHITECTURE.md is the architecture. The only edits made to the settler's text were renumbering the core-piece sections under section 3 and making the example sample count a placeholder.
