"""Quick Look: preliminary analysis of recorded runs, before you pack up.

Read-only by design - it opens run folders and ROOT files and never writes
into them. The only thing it keeps is a cache of per-event values under the
app's state directory, keyed by file and settings so it can never be stale.

Two stages, because the waveforms are big (channel[18][1024] float32 is
~74 KB per event before compression):

- stage 1 (`features`): one pass over a run's waveforms producing a small
  per-event table for every ROOT slot - pedestal, charge, peaks, CFD times,
  clipping - in a low-priority worker process, so the readout never waits.
  It reruns only when the processing settings (baseline/integration windows)
  change. A short preview pass over each run's first events comes first, so
  plots appear in seconds and sharpen when the full pass lands.
- stage 2 (`aggregate`): everything else - channel map, polarity, cuts,
  grouping, statistics - computed from those tables in milliseconds.

Everything is in DAQ channel numbering (0-15, TR0); `slots` is the one place
it meets the ROOT file's interleaved channel[18] order.
"""
