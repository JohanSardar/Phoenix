# mini-swe-agent

[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) is the SWE-bench team's 100-line coding agent. Its one tool is bash. It keeps no session, so it has no resume.

The harness is a folder with mini-swe-agent's own config file, `mini.yaml`. A replay starts at the first message with the moment's prompt. resume.py runs `mini` with that config and an environment that sends each command to Phoenix. mini-swe-agent's finish command, `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`, ends the run without running a shell. Anything after it in the same command is not run. The LLM is reached directly at its own host.

Moments for it are made up. Answer commands in the moment's world under the bash tool's service:

```yaml
tools:
  - { name: bash, service: shell, op: bash, description: Run one bash command., parameters: { type: object } }
world:
  - tool: shell.bash
    args: { command: ls }
    answer: "README.md\n"
  - tool: shell.bash
    answer: "the answer to any other command"
```

Build the box image with `docker build -f resume.Dockerfile -t phoenix-mini-swe-agent-resume:2.4.6 .` from this folder.
