# Tracking fixtures — interval ground truth

Each fixture can carry a `<name>.truth.json` with human-labeled identity truth,
written while watching the video — no tracker ids needed. The eval resolves
"left/right/center" to skeletons by mid-hip x position at that timestamp.

```json
{
  "checkpoints": [
    { "t": 5.0,  "fighter": "left" },
    { "t": 30.0, "fighter": "left" },
    { "t": 70.0, "fighter": "right" }
  ],
  "events": [
    { "t": 67.7, "kind": "track_follows_other", "note": "track drifts to pad holder" }
  ]
}
```

- **checkpoints**: every ~10-15s, where is the fighter in frame? (`left` /
  `right` / `center` = horizontal thirds). Add more around known trouble spots.
- **events**: moments where tracking visibly breaks (id swap, fragmentation
  burst, third party crossing). `kind` is free-form; `t` is what matters.

Metrics computed from this: fighter id-consistency across checkpoints (does one
canonical track cover them all), fighter coverage %, and id-switch counts near
events — before and after track repair.
