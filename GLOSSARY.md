# Phoenix

Phoenix records everything a harness does while it runs, so that a moment where it made a mistake can later be rebuilt in a sandbox and the harness edited and replayed until it does the right thing.

## Language

**Run**:
One execution of a harness on a task, either live against real systems or synthetic against a made-up world.
_Avoid_: Session, trajectory, episode

**Moment**:
A marked point in a run, flagged by the agent itself during the run or picked afterward from the recording, that a replay is built around.
_Avoid_: Snapshot, checkpoint, case

**Replay**:
A re-run of a moment in the sandbox, starting either from the beginning of the run or from the moment's mark.
_Avoid_: Rerun, simulation

**Harness**:
Anything that runs an agent on a task and reads its tools and model endpoints from config, official or self-made.
_Avoid_: Agent, framework, app

**Tool**:
Anything an agent can act through: an MCP server, a CLI command, or a direct API call.
_Avoid_: Connector (when the transport is meant), integration

**Capture**:
Recording, on our side of the boundary, everything that passes through one tool surface during a run.
_Avoid_: Snapshot, export, dump

**Capture recipe**:
A ready-made, installable way to capture a particular agent or tool surface, run alongside the agent so that setting up replay is easy.
_Avoid_: Plugin (when only capture is meant), integration

**Improver**:
Whoever edits the harness and replays the moment until it passes: usually an outside agent the person connects, or the person themselves by hand.
_Avoid_: Optimizer, fixer, evolve agent

**Success check**:
The written definition of the right thing at a moment, fixed before the loop starts: either a deterministic expectation (a tool call, an action, or an end state) or a plain-language statement of intended behavior.
_Avoid_: Rubric, eval, test, expected output

**Snapshot**:
The captured real state behind a moment from a live run.
_Avoid_: Export, dump, backup

**Scenario**:
A staged or seeded world for a situation that never happened live, which yields moments that replay the same way.
_Avoid_: Fixture, mock world, test environment

**Workbench**:
Phoenix's internal sandbox that the Improver drives to read a moment, edit the harness, replay, and check.
_Avoid_: Sandbox app, studio

**Login context**:
Text a harness adds to the model-request history depending on how it is signed in, such as the account's email, which a capture recipe declares so that a replay without that login can still match the frozen prefix.
_Avoid_: Account state, credentials

**Correction**:
A person's fix or rejection of what the agent did at a moment, which is the default starting point for its success check.
_Avoid_: Feedback, label, annotation
