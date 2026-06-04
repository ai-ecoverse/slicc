# Spike 3 — scratch prototype

Throwaway prototype for the
[Spike 3 task note](intent://local/note/af6f8cca-6055-4998-b9ab-eb9435a6114a).

## Run

From the repo root:

```
python3 -m http.server 8765
```

Then open <http://localhost:8765/packages/webapp/scratch/spike3-pyodide-opfs/index.html>
in Chrome (any context that exposes OPFS to a DedicatedWorker — desktop
Chrome ≥ 86 works fine). Click **Run (a)** to exercise the stock
`mountNativeFS` + `syncfs` path, then **Run (c)** for the custom
`OPFS_SYNC_FS` registration sketch.

The page reads the OPFS root directly after the worker returns so the
files Python wrote are visible through the same `FileSystemDirectoryHandle`
any Spike 1 OPFS-backed library would use.

Results are recorded in the task note.
