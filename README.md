# Phoenix

Phoenix is an open-source system that records everything an agent harness does while it runs, so that any moment from a live run can later be rebuilt in a sandbox with the same prompt, tools and connectors. An outside agent, or a person by hand, then edits the harness and replays that moment until the agent does the right thing, and the fixed harness is the same one that goes live. Today there is no way to do this: the services an agent touched have moved on, most vendors offer no on-demand snapshot, and any fix ends up tested against a different world than the one where the mistake happened.

- [Spec](docs/SPEC.md)
- [Glossary](GLOSSARY.md)
- [Architecture decision records](docs/adr/)

## Merging

Label a pull request `automerge` and it lands, squash-merged, once its checks pass.
