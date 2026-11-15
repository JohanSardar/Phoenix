# Fill

Each file in a moment's `data/fills/` holds one item that the chosen capture routes missed and the setup step filled in (ARCHITECTURE.md section 3.6): what the item is, the connector and event it belongs to, the filled `value`, and its `tag`. A fill is `derived` when a mechanical rule in `wire` built it, or when every value appears verbatim in evidence it cites; otherwise it is `synthesized`. `basis` names the rule and the evidence locations, and `producer` names what wrote it.
