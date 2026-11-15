# Lock

`moment.lock.json` is the portable record of a check approval (ARCHITECTURE.md section 3.6). It holds the moment id and the hashes of the manifest, the check, every custom-check file, every data file and every fill, by path, plus how it was locked (`approved` by a person, or `auto` for a scenario that opts in) and who approved and when. The lock's own hash goes into the approvals ledger.
