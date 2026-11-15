# The Improver decides pass or fail

The agent that edits the harness also decides whether a replay passed; there is no separate judge agent. This departs from the original spec, which kept the two apart so the Improver could not pass by making the test easier. The guards are that the success check is written down and approved before the loop, is never among the files the Improver may edit, and that its deterministic parts (an expected tool call, action, or end state) are checked by phoenix itself with a binding result. The Improver's judgment applies only to plain-language intent.
