# Phoenix

Phoenix is an open-source system that records everything an agent harness does while it runs, so that any moment from a live run can later be rebuilt in a sandbox with the same prompt, tools and connectors. An outside agent, or a person by hand, then edits the harness and replays that moment until the agent does the right thing, and the fixed harness is the same one that goes live. Today there is no way to do this: the services an agent touched have moved on, most vendors offer no on-demand snapshot, and any fix ends up tested against a different world than the one where the mistake happened.

## Install

```sh
curl -fsSL https://phoenix.eilmer.si/install | sh
```

This installs the latest release for macOS or Linux (arm64 or x64) into `~/.phoenix`, with its own Node.js, and verifies the download's SHA-256 checksum. Pin a version with `curl -fsSL https://phoenix.eilmer.si/install | sh -s -- v0.1.0`. Run the same command again to upgrade, and delete `~/.phoenix` to uninstall. Capture uses git and Python 3, and replays need Docker or Podman.

- [Spec](docs/SPEC.md)
- [Glossary](GLOSSARY.md)
- [Architecture decision records](docs/adr/)

## Limits

- Google Calendar through the claude.ai connector: the working copy does not support a successful `respond_to_event` (accepting or declining an invitation), and answers `unsupported` in a replay. It could not be recorded from one Google account. The "not an attendee" error is answered as recorded. See [the plugin's limits](plugins/google-calendar/README.md#limits).

## Merging

Label a pull request `automerge` and it lands, squash-merged, once its checks pass.

License: MIT, see LICENSE
