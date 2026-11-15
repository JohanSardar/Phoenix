# Harness contract

`phoenix.harness.yaml` sits in the harness repository and declares the three things the spec names (ARCHITECTURE.md section 3.5). `run` says how to run the harness: a `command` with its `output`, or for a long-lived server harness `serve`, `ready` and `submit`; either form may give `build` and `image`. `endpoints` says where the model API (`env` and `dialect`) and MCP servers (`file` and `format`) are configured. `editable` lists the globs of paths an Improver may change.
