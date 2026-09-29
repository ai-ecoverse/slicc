# Terminal-Bench 4.0 tool inventory for SLICC

Date: 2026-09-29. Source: [Terminal-Bench v4.0.0](https://github.com/harbor-framework/terminal-bench/releases/tag/v4.0.0), commit `452bf305c6daa62fc59061d22133a7cbc7c1572e` (66 tasks). Baseline: [feasibility study PR #3639](https://github.com/ai-ecoverse/slicc/pull/3639).

The upstream root [license is Apache-2.0](https://github.com/harbor-framework/terminal-bench/blob/v4.0.0/LICENSE). Individual assets can carry other terms. This inventory contains task IDs and dependency names; it reproduces no instructions, fixtures, tests, or solutions.

## Counting rules

- **Agent** counts a facility provisioned in the agent Dockerfile/base image, invoked by setup/reference code, or required to inspect/build the intended artifact. **Verifier** counts its separate Dockerfile/base image, `test.sh`, and test code. Counts are task counts, not invocation counts. Docker image build and runtime are included; generic `sh`, `cp`, `chmod`, and `ca-certificates` are omitted. `curl`/`wget` include image setup downloads, even if no agent command uses them.
- `pytest` and `pytest-json-ctrf` count only the 53 images that install/invoke them. For custom scorers, the table names the actual runtime. Python package names are expanded in the package matrix. Direct JavaScript dependencies are represented by the runtime/framework; their [task manifests](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks) are the exact version source.
- SLICC status is checked against [shell-reference.md](shell-reference.md), [package-execution](../packages/vfs-root/workspace/skills/package-execution/SKILL.md), WASMaxxing @thread:thr_b83wwqmt4e and phase 5 @thread:thr_fp88fktv76, merged [WASI phase 5a #3638](https://github.com/ai-ecoverse/slicc/pull/3638), open [phase 5b #3642](https://github.com/ai-ecoverse/slicc/pull/3642), and the published `@ai-ecoverse/wasm-*`/`wasi-*` package reports in @thread:thr_5bnnzy9z5q. “Available” means a SLICC equivalent exists, not byte-for-byte Linux parity.
- The official verifier remains a Harbor Linux container. A browser-side agent run becomes score-comparable only after image-state staging and artifact export; live sidecar state requires an additional bridge. The 22 F/P tasks in [PR #3639](https://github.com/ai-ecoverse/slicc/pull/3639) are an agent-side feasibility baseline, not 22 passed verifiers.

## Task requirements

Each task ID links to its pinned upstream directory, which contains the agent/verifier Dockerfiles, setup files, tests, and reference solution. `HTTP-daemon` means an active local HTTP endpoint; `Docker-Compose` means Harbor starts multiple containers. `Linux-ELF` means the task uses an architecture-specific native executable.

<!-- prettier-ignore -->
| Task ID | Agent-side facilities | Verifier-side facilities |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [atrx-vep-crispr](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/atrx-vep-crispr) | `curl`, `gcc`, `git`, `gzip`, `perl`, `python`, `samtools`, `tabix`, `tar`, `VEP`, `wget` | `curl`, `gcc`, `git`, `gzip`, `perl`, `pytest`, `pytest-json-ctrf`, `python`, `samtools`, `tabix`, `tar`, `VEP`, `wget` |
| [batched-eval-parity](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/batched-eval-parity) | `numpy`, `python` | `numpy`, `pytest`, `pytest-json-ctrf`, `python` |
| [biped-contact-dynamics](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/biped-contact-dynamics) | `drake`, `numpy`, `python`, `scipy` | `drake`, `numpy`, `pytest`, `pytest-json-ctrf`, `python`, `scipy` |
| [bun-sourcemap-leak](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/bun-sourcemap-leak) | `bash`, `bun`, `python`, `tmux`, `TypeScript` | `bun`, `pytest`, `pytest-json-ctrf`, `python`, `TypeScript` |
| [cad-model](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/cad-model) | `build123d`, `OpenCascade`, `python` | `cascadio`, `numpy`, `pytest`, `pytest-json-ctrf`, `python`, `scipy`, `trimesh` |
| [cargo-flight-dispatch](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/cargo-flight-dispatch) | `python` | `pytest`, `pytest-json-ctrf`, `python` |
| [coq-block-bound](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/coq-block-bound) | `Coq`, `curl`, `opam`, `sudo` | `Coq`, `pytest`, `pytest-json-ctrf`, `python` |
| [ctr-optimization](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/ctr-optimization) | `curl`, `Docker-Compose`, `HTTP-daemon`, `numpy`, `pandas`, `python`, `requests`, `scipy` | `Docker-Compose`, `HTTP-daemon`, `numpy`, `pytest`, `pytest-json-ctrf`, `python`, `scipy` |
| [cumulative-layout-shift](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/cumulative-layout-shift) | `Docker-Compose`, `git`, `HTTP-daemon`, `Next.js`, `node`, `pnpm`, `React`, `TypeScript` | `Chromium`, `curl`, `Docker-Compose`, `git`, `HTTP-daemon`, `node`, `Playwright`, `pnpm`, `React`, `TypeScript` |
| [data-anonymization](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/data-anonymization) | `python`, `PyYAML`, `sqlite3` | `psutil`, `pytest`, `pytest-json-ctrf`, `python`, `PyYAML`, `sqlite3` |
| [distributed-dedup](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/distributed-dedup) | `curl`, `Java`, `sbt`, `Scala`, `tar` | `curl`, `Java`, `pytest`, `pytest-json-ctrf`, `python`, `sbt`, `Scala`, `tar` |
| [embedding-drift-monitor](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/embedding-drift-monitor) | `curl`, `numpy`, `python`, `scipy` | `numpy`, `pytest`, `pytest-json-ctrf`, `python`, `scipy` |
| [fin-saccr-rwa](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/fin-saccr-rwa) | `openpyxl`, `python` | `openpyxl`, `pytest`, `pytest-json-ctrf`, `python` |
| [foodstuff-beta-activity](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/foodstuff-beta-activity) | `curl`, `pandas`, `pdfplumber`, `python`, `xlrd` | `pytest`, `pytest-json-ctrf`, `python` |
| [formal-crypto](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/formal-crypto) | `bzip2`, `curl`, `python`, `SageMath` | `gcc`, `Go`, `pytest`, `pytest-json-ctrf`, `python`, `SageMath`, `tar` |
| [fp8-rmsnorm-gemm](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/fp8-rmsnorm-gemm) | `CUDA`, `curl`, `gcc`, `git`, `GPU`, `numpy`, `python`, `torch` | `CUDA`, `gcc`, `GPU`, `numpy`, `pytest`, `pytest-json-ctrf`, `python`, `torch` |
| [freecad-impeller](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/freecad-impeller) | `curl`, `FreeCAD`, `git`, `node`, `numpy`, `python`, `scipy` | `FreeCAD`, `numpy`, `pydantic`, `python`, `scipy`, `Xvfb` |
| [freecad-platform-drawing](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/freecad-platform-drawing) | `curl`, `FreeCAD`, `git`, `node`, `numpy`, `python`, `scipy` | `FreeCAD`, `numpy`, `pydantic`, `python`, `scipy`, `Xvfb` |
| [freecad-spring-clip](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/freecad-spring-clip) | `curl`, `FreeCAD`, `git`, `node`, `numpy`, `python`, `scipy` | `FreeCAD`, `numpy`, `pydantic`, `python`, `scipy`, `Xvfb` |
| [freight-dispatch-shift](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/freight-dispatch-shift) | `Docker-Compose`, `HTTP-daemon`, `node`, `npm`, `python` | `Docker-Compose`, `HTTP-daemon`, `node`, `npm`, `python` |
| [glycan-ms2-elucidation](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/glycan-ms2-elucidation) | `curl`, `numpy`, `openpyxl`, `python` | `numpy`, `openpyxl`, `pytest`, `pytest-json-ctrf`, `python` |
| [gsea-proteomics](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/gsea-proteomics) | `curl`, `GSEA`, `Java`, `numpy`, `pandas`, `python`, `scipy`, `statsmodels`, `unzip` | `pytest`, `pytest-json-ctrf`, `python` |
| [heat-pump-warranty](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/heat-pump-warranty) | `curl`, `Docker-Compose`, `HTTP-daemon`, `jq`, `python`, `tesseract` | `Docker-Compose`, `HTTP-daemon`, `python` |
| [hof-topology-interpenetration](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/hof-topology-interpenetration) | `curl`, `gemmi`, `networkx`, `numpy`, `python`, `scipy` | `pytest`, `pytest-json-ctrf`, `python` |
| [html-js-filter](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/html-js-filter) | `beautifulsoup4`, `lxml`, `python` | `beautifulsoup4`, `Chromium`, `curl`, `lxml`, `Playwright`, `pytest`, `pytest-json-ctrf`, `python` |
| [interleaved-vigenere](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/interleaved-vigenere) | `python`, `wamerican` | `pytest`, `pytest-json-ctrf`, `python` |
| [intrastat-meldung](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/intrastat-meldung) | `curl`, `Docker-Compose`, `Flask`, `HTTP-daemon`, `jq`, `python`, `PyYAML`, `reportlab`, `requests` | `Docker-Compose`, `HTTP-daemon`, `jsonschema`, `pytest`, `pytest-json-ctrf`, `python` |
| [jax-speedrun-gpu](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/jax-speedrun-gpu) | `cmake`, `CUDA`, `curl`, `flax`, `gcc`, `git`, `GPU`, `huggingface-hub`, `JAX`, `numpy`, `optax`, `python`, `safetensors`, `tqdm`, `wget`, `zip` | `cmake`, `CUDA`, `curl`, `flax`, `gcc`, `git`, `GPU`, `huggingface-hub`, `JAX`, `numpy`, `optax`, `pytest`, `pytest-json-ctrf`, `python`, `safetensors`, `tqdm`, `wget` |
| [ks-solver-cpp](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/ks-solver-cpp) | `g++`, `python` | `g++`, `numpy`, `python` |
| [kv-live-surgery](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/kv-live-surgery) | `curl`, `Docker-Compose`, `gcc`, `gdb`, `iproute2`, `ltrace`, `procps`, `python`, `raw-process`, `strace`, `TCP-daemon`, `wget` | `Docker-Compose`, `python`, `raw-process`, `TCP-daemon` |
| [lake-temp-glm](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/lake-temp-glm) | `cma`, `curl`, `netCDF4`, `numpy`, `pandas`, `python`, `scipy`, `torch` | `numpy`, `pandas`, `pytest`, `pytest-json-ctrf`, `python`, `torch` |
| [layout-config-recreation](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/layout-config-recreation) | `Chromium`, `curl`, `Pillow`, `Playwright`, `python`, `tar` | `Chromium`, `curl`, `numpy`, `Pillow`, `Playwright`, `pytest`, `pytest-json-ctrf`, `python`, `tar` |
| [layout-config-recreation2](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/layout-config-recreation2) | `curl`, `Pillow`, `python`, `tar`, `xz` | `curl`, `numpy`, `Pillow`, `pytest`, `pytest-json-ctrf`, `python`, `tar`, `xz` |
| [legacy-utility-triage](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/legacy-utility-triage) | `Docker-Compose`, `HTTP-daemon`, `ImageMagick`, `netcat`, `python`, `tesseract`, `VNC` | `Docker-Compose`, `HTTP-daemon`, `python`, `VNC` |
| [live-database-cutover](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/live-database-cutover) | `cryptography`, `curl`, `Docker-Compose`, `FastAPI`, `git`, `gunicorn`, `HTTP-daemon`, `MySQL`, `PostgreSQL`, `pymysql`, `python`, `Redis`, `redis-py`, `SQLAlchemy`, `uvicorn` | `cryptography`, `curl`, `Docker-Compose`, `FastAPI`, `git`, `gunicorn`, `HTTP-daemon`, `httpx`, `MySQL`, `PostgreSQL`, `psycopg2`, `pymysql`, `pytest`, `pytest-json-ctrf`, `python`, `Redis`, `redis-py`, `SQLAlchemy`, `uvicorn` |
| [math-eval-grader](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/math-eval-grader) | `accelerate`, `antlr4-python3-runtime`, `curl`, `git`, `huggingface-hub`, `poppler`, `PyMuPDF`, `python`, `sympy`, `torch`, `transformers` | `antlr4-python3-runtime`, `curl`, `pytest`, `pytest-json-ctrf`, `python`, `sympy` |
| [medical-claims-processing](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/medical-claims-processing) | `curl`, `Docker-Compose`, `HTTP-daemon`, `Pillow`, `Playwright`, `pytesseract`, `python`, `requests`, `tesseract`, `VNC` | `Docker-Compose`, `HTTP-daemon`, `Playwright`, `pytest`, `pytest-json-ctrf`, `python`, `VNC` |
| [mp-checkpoint-consolidation](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/mp-checkpoint-consolidation) | `curl`, `gcc`, `numpy`, `python`, `safetensors`, `torch` | `numpy`, `pytest`, `pytest-json-ctrf`, `python`, `safetensors`, `torch` |
| [music-harmony](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/music-harmony) | `music21`, `python` | `music21`, `python` |
| [mvcc-lsm-compaction](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/mvcc-lsm-compaction) | `g++`, `gcc`, `make`, `patch`, `python` | `g++`, `gcc`, `make`, `pytest`, `pytest-json-ctrf`, `python` |
| [nextjs-performance](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/nextjs-performance) | `Docker-Compose`, `HTTP-daemon`, `Next.js`, `node`, `npm`, `React`, `TypeScript` | `Chromium`, `curl`, `Docker-Compose`, `HTTP-daemon`, `Next.js`, `node`, `npm`, `Playwright`, `React`, `TypeScript` |
| [ontology-kg-querying](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/ontology-kg-querying) | `python`, `rdflib` | `python`, `rdflib` |
| [payments-pipeline-fix](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/payments-pipeline-fix) | `confluent-kafka`, `curl`, `Docker-Compose`, `HTTP-daemon`, `Kafka`, `python`, `supervisor` | `aiohttp`, `confluent-kafka`, `curl`, `Docker-Compose`, `HTTP-daemon`, `httpx`, `Kafka`, `pytest`, `pytest-json-ctrf`, `python`, `supervisor`, `tar` |
| [photonic-waveguide-routing](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/photonic-waveguide-routing) | `numpy`, `python`, `rtree`, `scipy`, `shapely` | `matplotlib`, `pytest`, `pytest-json-ctrf`, `python` |
| [pretrain-shard-corruption](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/pretrain-shard-corruption) | `curl`, `git`, `litdata`, `numpy`, `python`, `sentencepiece`, `torch` | `curl`, `numpy`, `pytest`, `pytest-json-ctrf`, `python`, `sentencepiece`, `torch` |
| [production-planning](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/production-planning) | `python`, `PyYAML`, `sqlite3` | `pytest`, `pytest-json-ctrf`, `python`, `PyYAML`, `sqlite3` |
| [protein-autointerp-disulfide](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/protein-autointerp-disulfide) | `biopython`, `curl`, `git`, `python`, `requests`, `wget` | `curl`, `pytest`, `pytest-json-ctrf`, `python` |
| [react-lead-form](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/react-lead-form) | `happy-dom`, `node`, `npm`, `React`, `tmux`, `tsx`, `TypeScript`, `Vite`, `Vitest` | `happy-dom`, `node`, `npm`, `React`, `tsx`, `TypeScript`, `Vite`, `Vitest` |
| [retro-console-soc](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/retro-console-soc) | `curl`, `g++`, `gcc`, `make`, `nextpnr`, `python`, `Verilator`, `yosys` | `curl`, `g++`, `gcc`, `make`, `nextpnr`, `Pillow`, `pytest`, `pytest-json-ctrf`, `python`, `Verilator`, `yosys` |
| [risk-scorer-replay](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/risk-scorer-replay) | `gcc`, `Linux-ELF`, `python`, `sqlite3` | `gcc`, `Linux-ELF`, `pytest`, `pytest-json-ctrf`, `python`, `sqlite3` |
| [roy-polymorph-cn](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/roy-polymorph-cn) | `curl`, `gcc`, `numpy`, `pandas`, `python`, `RDKit`, `scipy` | `curl`, `pandas`, `pytest`, `pytest-json-ctrf`, `python` |
| [rs-archive-clone](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/rs-archive-clone) | `curl`, `Linux-ELF`, `python` | `gcc`, `Linux-ELF`, `pytest`, `pytest-json-ctrf`, `python` |
| [satb-audio-transcription](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/satb-audio-transcription) | `curl`, `ffmpeg`, `libsndfile`, `numpy`, `python`, `scipy`, `unzip` | `curl`, `lxml`, `pytest`, `pytest-json-ctrf`, `python`, `unzip` |
| [session-window-debug](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/session-window-debug) | `python`, `tmux`, `uv` | `pytest`, `pytest-json-ctrf`, `python` |
| [sglang-qwen-burst](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/sglang-qwen-burst) | `curl`, `git`, `python` | `curl`, `git`, `openai`, `orjson`, `partial-json-parser`, `pydantic`, `pydantic-core`, `pytest`, `pytest-json-ctrf`, `python` |
| [shadow-relay](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/shadow-relay) | `git`, `pycryptodome`, `python` | `git`, `pycryptodome`, `pytest`, `pytest-json-ctrf`, `python` |
| [sound-change-cascade](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/sound-change-cascade) | `git`, `python` | `curl`, `pytest`, `pytest-json-ctrf`, `python` |
| [takens-embedding-lean](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/takens-embedding-lean) | `curl`, `elan`, `git`, `lake`, `Lean`, `python` | `curl`, `elan`, `git`, `lake`, `Lean`, `pytest`, `pytest-json-ctrf`, `python` |
| [telecom-entity-resolution](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/telecom-entity-resolution) | `curl`, `git`, `pandas`, `python`, `unzip`, `wget` | `curl`, `pandas`, `pytest`, `pytest-json-ctrf`, `python` |
| [uefi-bootkit](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/uefi-bootkit) | `curl`, `OVMF`, `python`, `qcow2`, `QEMU` | `curl`, `mtools`, `OVMF`, `pytest`, `pytest-json-ctrf`, `python`, `qcow2`, `QEMU` |
| [vba-userform-port](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/vba-userform-port) | `curl`, `HTTP-daemon`, `node`, `npm`, `python`, `React`, `sqlite3`, `Vite` | `Chromium`, `curl`, `HTTP-daemon`, `node`, `npm`, `Playwright`, `pytest`, `pytest-json-ctrf`, `python`, `React`, `requests`, `sqlite3`, `Vite` |
| [vf2-speedup-networkx](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/vf2-speedup-networkx) | `cargo`, `cmake`, `curl`, `g++`, `gcc`, `git`, `python`, `rustc`, `setuptools` | `networkx`, `pytest`, `pytest-json-ctrf`, `python` |
| [vllm-deepseek-streaming](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/vllm-deepseek-streaming) | `patch`, `python`, `torch`, `vLLM` | `pytest`, `pytest-json-ctrf`, `python`, `torch`, `vLLM` |
| [vpp-loss-divergence](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/vpp-loss-divergence) | `accelerate`, `cloudpickle`, `datasets`, `einops`, `fiddle`, `gcc`, `git`, `huggingface-hub`, `hydra-core`, `lightning`, `megatron-core`, `nemo-toolkit`, `numpy`, `omegaconf`, `psutil`, `python`, `pytorch-lightning`, `safetensors`, `scipy`, `sentencepiece`, `tensorboard`, `tensorstore`, `torch`, `transformers`, `webdataset`, `wrapt`, `zarr` | `accelerate`, `cloudpickle`, `datasets`, `einops`, `fiddle`, `gcc`, `git`, `huggingface-hub`, `hydra-core`, `lightning`, `megatron-core`, `nemo-toolkit`, `numpy`, `omegaconf`, `psutil`, `pytest`, `pytest-json-ctrf`, `python`, `pytorch-lightning`, `safetensors`, `scipy`, `sentencepiece`, `tensorboard`, `tensorstore`, `torch`, `transformers`, `webdataset`, `wrapt`, `zarr` |
| [wal-recovery-ordering](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/wal-recovery-ordering) | `python` | `hypothesis`, `pytest`, `pytest-json-ctrf`, `python`, `setpriv` |
| [wdm-design](https://github.com/harbor-framework/terminal-bench/tree/v4.0.0/tasks/wdm-design) | `autograd`, `matplotlib`, `nlopt`, `pymeep`, `python`, `scipy` | `autograd`, `nlopt`, `pymeep`, `pytest`, `pytest-json-ctrf`, `python`, `scipy` |

The `atrx-vep-crispr` VEP image also provisions Perl `DBI`, `DBD::mysql`, `Bio::Perl`, `Bio::DB::HTS`, `Set::IntervalTree`, `JSON`, `File::Copy::Recursive`, `Try::Tiny`, `CGI`, and `Test::*` modules on both sides. The `cumulative-layout-shift` site has direct `@radix-ui/*`, `react-hook-form`, `recharts`, `tailwindcss`, and `zod` dependencies alongside `next`/`react`; see its pinned [site manifest](https://github.com/harbor-framework/terminal-bench/blob/v4.0.0/tasks/cumulative-layout-shift/environment/barber-shop-site/package.json). `react-lead-form` uses `@testing-library/*`, `happy-dom`, `vite`, `vitest`, and `tsx`; see its [app manifest](https://github.com/harbor-framework/terminal-bench/blob/v4.0.0/tasks/react-lead-form/environment/app/package.json). These package manifests specify the full direct and transitive npm dependency sets.

## Tool and runtime matrix

**Status:** A = available now (sometimes with the stated parity limit); I = available through `ipk`; B = being built in WASMaxxing; P = planned; W = missing but a WASM/browser port is technically plausible; K = exact task facility cannot be supplied by an ordinary browser worker. A browser VM such as `v86` is a distinct execution environment and does not make the original Harbor verifier reproducible inside the SLICC shell. Counts below come from the task table; Python distributions follow in the next matrix.

<!-- prettier-ignore -->
| Tool / facility | Agent | Verifier | Status | Evidence / limit |
| ---------------- | ----: | -------: | ------ | ----------------------------------------------------------------------- |
| `python` | 61 | 63 | I | Pyodide via `ipk add pyodide`; VFS/subprocess limits |
| `curl` | 38 | 22 | I | built-in HTTP; full `@ai-ecoverse/wasm-curl` via ipk |
| `git` | 18 | 8 | I | built-in subset; full `@ai-ecoverse/wasm-git` via ipk |
| `Docker-Compose` | 11 | 11 | K | host kernel, device, container, or native daemon fidelity required |
| `gcc` | 11 | 9 | W | WASM port/package or browser adaptation required |
| `HTTP-daemon` | 11 | 11 | B | loopback WASI server in #3642; arbitrary daemon unproven |
| `node` | 8 | 5 | A | JS realm/ipk; full Node process and scripts need validation |
| `Playwright` | 2 | 6 | A | browser automation exists; exact Linux verifier remains external |
| `tar` | 4 | 6 | I | built-in or `@ai-ecoverse/wasm-*` via ipk |
| `Chromium` | 1 | 5 | A | browser automation exists; exact Linux verifier remains external |
| `wget` | 5 | 2 | A | browser shell command |
| `g++` | 4 | 3 | W | WASM port/package or browser adaptation required |
| `npm` | 4 | 4 | A | JS realm/ipk; full Node process and scripts need validation |
| `React` | 4 | 4 | I | installable JS packages via ipk; scripts need validation |
| `sqlite3` | 4 | 4 | A | SQLite `sql.js` shell / Python stdlib |
| `TypeScript` | 4 | 4 | A | JS realm/ipk; full Node process and scripts need validation |
| `FreeCAD` | 3 | 3 | W | WASM port/package or browser adaptation required |
| `tesseract` | 3 | 0 | W | WASM port/package or browser adaptation required |
| `tmux` | 3 | 0 | W | GNU bash jobs exist; tmux itself not ported |
| `unzip` | 3 | 1 | A | browser shell command |
| `Xvfb` | 0 | 3 | W | WASM port/package or browser adaptation required |
| `cmake` | 2 | 1 | W | WASM port/package or browser adaptation required |
| `CUDA` | 2 | 2 | K | host kernel, device, container, or native daemon fidelity required |
| `GPU` | 2 | 2 | K | host kernel, device, container, or native daemon fidelity required |
| `Java` | 2 | 1 | W | WASM port/package or browser adaptation required |
| `jq` | 2 | 0 | A | browser shell command |
| `Linux-ELF` | 2 | 2 | K | host kernel, device, container, or native daemon fidelity required |
| `make` | 2 | 2 | I | built-in or `@ai-ecoverse/wasm-*` via ipk |
| `Next.js` | 2 | 1 | W | package install/server parity incomplete |
| `patch` | 2 | 0 | A | browser shell command |
| `Vite` | 2 | 2 | I | installable JS packages via ipk; scripts need validation |
| `VNC` | 2 | 2 | K | host kernel, device, container, or native daemon fidelity required |
| `bash` | 1 | 0 | I | built-in or `@ai-ecoverse/wasm-*` via ipk |
| `bun` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `bzip2` | 1 | 0 | W | WASM port/package or browser adaptation required |
| `cargo` | 1 | 0 | W | WASM port/package or browser adaptation required |
| `Coq` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `elan` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `ffmpeg` | 1 | 0 | I | `@ffmpeg/core` via ipk; codec coverage differs |
| `gdb` | 1 | 0 | K | host kernel, device, container, or native daemon fidelity required |
| `Go` | 0 | 1 | P | WASI compile/link packages published; `go build` driver planned (5e) |
| `GSEA` | 1 | 0 | W | WASM port/package or browser adaptation required |
| `gzip` | 1 | 1 | I | built-in or `@ai-ecoverse/wasm-*` via ipk |
| `happy-dom` | 1 | 1 | I | installable JS packages via ipk; scripts need validation |
| `ImageMagick` | 1 | 0 | I | `@imagemagick/magick-wasm` via ipk |
| `iproute2` | 1 | 0 | K | host kernel, device, container, or native daemon fidelity required |
| `Kafka` | 1 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `lake` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `Lean` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `libsndfile` | 1 | 0 | W | WASM port/package or browser adaptation required |
| `ltrace` | 1 | 0 | K | host kernel, device, container, or native daemon fidelity required |
| `mtools` | 0 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `MySQL` | 1 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `netcat` | 1 | 0 | B | loopback sockets in #3642; raw external TCP unavailable |
| `nextpnr` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `opam` | 1 | 0 | W | WASM port/package or browser adaptation required |
| `OpenCascade` | 1 | 0 | W | WASM port/package or browser adaptation required |
| `OVMF` | 1 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `perl` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `pnpm` | 1 | 1 | W | package install/server parity incomplete |
| `poppler` | 1 | 0 | W | WASM port/package or browser adaptation required |
| `PostgreSQL` | 1 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `procps` | 1 | 0 | K | host kernel, device, container, or native daemon fidelity required |
| `qcow2` | 1 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `QEMU` | 1 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `raw-process` | 1 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `Redis` | 1 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `rustc` | 1 | 0 | W | WASM port/package or browser adaptation required |
| `SageMath` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `samtools` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `sbt` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `Scala` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `setpriv` | 0 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `strace` | 1 | 0 | K | host kernel, device, container, or native daemon fidelity required |
| `sudo` | 1 | 0 | K | host kernel, device, container, or native daemon fidelity required |
| `supervisor` | 1 | 1 | K | host kernel, device, container, or native daemon fidelity required |
| `tabix` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `TCP-daemon` | 1 | 1 | B | WASI loopback sockets in #3642; original ELF daemon remains unavailable |
| `tsx` | 1 | 1 | I | installable JS packages via ipk; scripts need validation |
| `uv` | 1 | 0 | W | WASM port/package or browser adaptation required |
| `VEP` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `Verilator` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `Vitest` | 1 | 1 | I | installable JS packages via ipk; scripts need validation |
| `wamerican` | 1 | 0 | A | stage dictionary file from image |
| `xz` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `yosys` | 1 | 1 | W | WASM port/package or browser adaptation required |
| `zip` | 1 | 0 | A | browser shell command |

The direct CLI names `openssl` and `zstd` occur in **0** of the pinned agent/verifier setup or reference command paths inspected here; `tar`/`xz`/`gzip` do occur. `gcc` includes `build-essential`/`g++` cases where the compiler is a dependency; the separate `g++` row counts explicit C++ needs.

### Python distributions

SLICC pins Pyodide `314.0.6` in `package-lock.json`. **CDN** means the name exists in its [lockfile](https://cdn.jsdelivr.net/pyodide/v314.0.6/full/pyodide-lock.json); the lockfile version is shown. **micropip candidate** means PyPI currently publishes a pure `none-any` wheel, but transitive dependencies and the task’s exact pin still need testing. **WASM build needed** means neither criterion held, or a native dependency makes the pure top-level wheel insufficient. Pyodide [loads its own compiled wheels and pure wheels](https://pyodide.org/en/latest/usage/loading-packages.html); micropip cannot load ordinary manylinux wheels. Upstream task pins often differ from the Pyodide lock; `di add` must use the locked version or an independently compatible pure wheel.

<!-- prettier-ignore -->
| Package | Agent | Verifier | Route |
| ------------------------ | ----: | -------: | ------------------------------------------------------ |
| `pytest` | 0 | 53 | CDN 9.0.2 |
| `pytest-json-ctrf` | 0 | 53 | micropip candidate (verifier only) |
| `numpy` | 19 | 18 | CDN 2.4.6 |
| `scipy` | 14 | 9 | CDN 1.18.0 |
| `torch` | 7 | 6 | WASM build needed (PyTorch native) |
| `pandas` | 6 | 3 | CDN 3.0.2 |
| `pydantic` | 0 | 4 | CDN 2.12.5 |
| `requests` | 4 | 1 | CDN 2.33.1 |
| `huggingface-hub` | 3 | 2 | micropip candidate |
| `Pillow` | 3 | 3 | CDN 12.2.0 |
| `PyYAML` | 3 | 2 | CDN 6.0.3 |
| `safetensors` | 3 | 3 | CDN 0.7.0 |
| `accelerate` | 2 | 1 | micropip candidate |
| `httpx` | 0 | 2 | CDN 0.28.1 |
| `lxml` | 1 | 2 | CDN 6.0.2 |
| `openpyxl` | 2 | 2 | micropip candidate |
| `psutil` | 1 | 2 | WASM build needed |
| `sentencepiece` | 2 | 2 | CDN 0.2.1 |
| `transformers` | 2 | 1 | micropip candidate |
| `aiohttp` | 0 | 1 | CDN 3.13.5 |
| `antlr4-python3-runtime` | 1 | 1 | micropip candidate |
| `autograd` | 1 | 1 | micropip candidate |
| `beautifulsoup4` | 1 | 1 | CDN 4.14.3 |
| `biopython` | 1 | 0 | CDN 1.87 |
| `build123d` | 1 | 0 | micropip wheel; `cascadio`/OpenCascade blocks full use |
| `cascadio` | 0 | 1 | WASM build needed |
| `cloudpickle` | 1 | 1 | CDN 3.1.2 |
| `cma` | 1 | 0 | micropip candidate |
| `confluent-kafka` | 1 | 1 | WASM build needed |
| `cryptography` | 1 | 1 | CDN 47.0.0 |
| `datasets` | 1 | 1 | micropip candidate |
| `drake` | 1 | 1 | WASM build needed |
| `einops` | 1 | 1 | micropip candidate |
| `FastAPI` | 1 | 1 | CDN 0.136.1 |
| `fiddle` | 1 | 1 | micropip candidate |
| `Flask` | 1 | 0 | micropip candidate |
| `flax` | 1 | 1 | micropip candidate |
| `gemmi` | 1 | 0 | WASM build needed |
| `gunicorn` | 1 | 1 | micropip candidate |
| `hydra-core` | 1 | 1 | micropip candidate |
| `hypothesis` | 0 | 1 | micropip candidate (pinned `6.122.3` pure wheel) |
| `JAX` | 1 | 1 | micropip candidate |
| `jsonschema` | 0 | 1 | CDN 4.26.0 |
| `lightning` | 1 | 1 | micropip candidate |
| `litdata` | 1 | 0 | micropip candidate |
| `matplotlib` | 1 | 1 | CDN 3.10.8 |
| `megatron-core` | 1 | 1 | WASM build needed |
| `music21` | 1 | 1 | micropip candidate |
| `nemo-toolkit` | 1 | 1 | micropip candidate |
| `netCDF4` | 1 | 0 | CDN 1.7.4 |
| `networkx` | 1 | 1 | CDN 3.6.1 |
| `nlopt` | 1 | 1 | CDN 2.9.1 |
| `omegaconf` | 1 | 1 | micropip candidate |
| `openai` | 0 | 1 | CDN 2.30.0 |
| `optax` | 1 | 1 | micropip candidate |
| `orjson` | 0 | 1 | CDN 3.11.8 |
| `partial-json-parser` | 0 | 1 | micropip candidate |
| `pdfplumber` | 1 | 0 | micropip candidate |
| `psycopg2` | 0 | 1 | WASM build needed |
| `pycryptodome` | 1 | 1 | CDN 3.23.0 |
| `pydantic-core` | 0 | 1 | CDN 2.41.5 |
| `pymeep` | 1 | 1 | WASM build needed (Meep/MPB native) |
| `PyMuPDF` | 1 | 0 | CDN 1.27.2.2 |
| `pymysql` | 1 | 1 | micropip candidate |
| `pytesseract` | 1 | 0 | micropip candidate |
| `pytorch-lightning` | 1 | 1 | micropip candidate |
| `rdflib` | 1 | 1 | micropip candidate |
| `RDKit` | 1 | 0 | WASM build needed |
| `redis-py` | 1 | 1 | micropip candidate |
| `reportlab` | 1 | 0 | micropip candidate |
| `rtree` | 1 | 0 | WASM build needed |
| `setuptools` | 1 | 0 | CDN 82.0.1 |
| `shapely` | 1 | 0 | CDN 2.1.2 |
| `SQLAlchemy` | 1 | 1 | CDN 2.0.48 |
| `statsmodels` | 1 | 0 | CDN 0.14.6 |
| `sympy` | 1 | 1 | CDN 1.14.0 |
| `tensorboard` | 1 | 1 | micropip candidate |
| `tensorstore` | 1 | 1 | WASM build needed |
| `tqdm` | 1 | 1 | CDN 4.67.3 |
| `trimesh` | 0 | 1 | micropip candidate |
| `uvicorn` | 1 | 1 | micropip candidate |
| `vLLM` | 1 | 1 | WASM build needed |
| `webdataset` | 1 | 1 | micropip candidate |
| `wrapt` | 1 | 1 | CDN 2.1.2 |
| `xlrd` | 1 | 0 | CDN 2.0.2 |
| `zarr` | 1 | 1 | CDN 3.2.1 |

Additional direct package pins in reference setup: `xlrd==2.0.1` (`foodstuff-beta-activity`), `build123d==0.10.0` (`cad-model`), `music21==7.3.3` (`music-harmony`), `requests==2.32.4` and `biopython==1.85` (`protein-autointerp-disulfide`). The exact versions for every Dockerfile-installed distribution are in the linked task directories; Pyodide lock presence does not imply that those pins can be installed unchanged.

### Services and system facilities

<!-- prettier-ignore -->
| Requirement | Task IDs | Browser alternative / limit |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local HTTP endpoints | `ctr-optimization`, `cumulative-layout-shift`, `freight-dispatch-shift`, `heat-pump-warranty`, `intrastat-meldung`, `legacy-utility-triage`, `live-database-cutover`, `medical-claims-processing`, `nextjs-performance`, `payments-pipeline-fix`, `vba-userform-port` | SLICC `serve` and worker loopback cover simple handlers; #3642 adds inherited WASI listeners. They do not supply these applications or their persisted state. |
| Docker Compose / multiple containers | `ctr-optimization`, `cumulative-layout-shift`, `freight-dispatch-shift`, `heat-pump-warranty`, `intrastat-meldung`, `kv-live-surgery`, `legacy-utility-triage`, `live-database-cutover`, `nextjs-performance`, `payments-pipeline-fix`, `medical-claims-processing` | No browser container runtime; model specific services in WASM/JS or retain Harbor sidecars. All listed task IDs declare Compose in the pinned environment. |
| MySQL + PostgreSQL + Redis | `live-database-cutover` | `sqlite3`/`sql.js` cannot preserve MySQL binlog/GTID, PostgreSQL MVCC/`pg_dump`, Redis RDB, or service state. |
| Raw TCP server and Linux process inspection | `kv-live-surgery` | #3642 gives WASI loopback sockets, but the task uses a native ELF server plus `/proc`, `ptrace`, `strace`, `ltrace`, `gdb`, and `iproute2`. |
| Kafka | `payments-pipeline-fix` | A JS queue could mimic some messages, but the task verifier starts Kafka and replays its snapshot. |
| VNC / desktop process | `legacy-utility-triage` | Browser UI automation exists; its native VNC workstation and OCR workflow are different facilities. |
| CUDA GPU | `fp8-rmsnorm-gemm`, `jax-speedrun-gpu` | WebGPU is not CUDA and cannot satisfy the pinned CUDA verifier. |
| VM firmware/disk | `uefi-bootkit` | `v86` can boot some x86 guests; it does not reproduce QEMU+OVMF/qcow2 verifier semantics. |
| SQLite database | `data-anonymization`, `production-planning`, `risk-scorer-replay`, `vba-userform-port` | SLICC `sqlite3`/`sql.js` and Pyodide `sqlite3` can cover file-backed data when exact filesystem locking/process behavior is unnecessary. |

The pinned Compose sidecar names are: `ctr-optimization`: `api`; `cumulative-layout-shift`: `barber-shop-data-backend`; `freight-dispatch-shift`: `event-feed`; `heat-pump-warranty`: `warranty-portal`, `asset-ledger`, `document-vault`, `returns-ledger`, `compliance-ledger`, `warranty-inbox`; `intrastat-meldung`: `odoo`, `compliance-hub`, `idev`, `services`, `dms`; `kv-live-surgery`: `loadgen`; `legacy-utility-triage`: `legacy-workstation`, `legacy-app`; `live-database-cutover`: `mysql-db`, `redis`, `postgres-db`, `customer`; `medical-claims-processing`: `playwright-mcp`, `workspace`; `nextjs-performance`: `warehouse-api`; `payments-pipeline-fix`: `kafka`, `seeder`, `customer`.

## Unlock order (agent-side upper bound)

This is a **conditional dependency ladder**, not a claim that the original verifier passes in the browser. It assumes the agent-visible image files are staged and Harbor runs the unchanged verifier. A step counts a task only when its listed facilities are jointly present; most individual tools have zero marginal gain until a companion library/runtime arrives. The rank is by number of newly plausible tasks at that step; equal-yield steps are ordered by tool reach in the matrix. Excluding the first two baseline rows, costs and engineering effort are not part of the rank.

<!-- prettier-ignore -->
| Rank | Add facility set | New task IDs | New | Cumulative plausible |
| ---: | --------------------------------------------------------- | --------------------------------------------------------------------------- | --: | -------------------: |
| 0 | Files staged plus current Pyodide-compatible packages | 1 F + 21 P tasks in [#3639](https://github.com/ai-ecoverse/slicc/pull/3639) | 22 | 22 |
| 1 | `FreeCAD`, OpenCascade, matching Python binding | `freecad-impeller`, `freecad-platform-drawing`, `freecad-spring-clip` | 3 | 25 |
| 2 | `gcc`/`g++`, libc/sysroot, `make` producing runnable WASM | `ks-solver-cpp`, `mvcc-lsm-compaction` | 2 | 27 |
| 3 | Full Node/Vite/Vitest script parity over `ipk` | `react-lead-form` | 1 | 28 |
| 4 | `torch` CPU + `safetensors` in Pyodide/WASM | `mp-checkpoint-consolidation` | 1 | 29 |
| 5 | `torch` companions `litdata`/`sentencepiece` | `pretrain-shard-corruption` | 1 | 30 |
| 6 | `torch` companions `netCDF4`/`cma` | `lake-temp-glm` | 1 | 31 |
| 7 | `Bun` runtime | `bun-sourcemap-leak` | 1 | 32 |
| 8 | `Coq`/`coqc` | `coq-block-bound` | 1 | 33 |
| 9 | `Lean`/`lake`/`elan` | `takens-embedding-lean` | 1 | 34 |
| 10 | Original browser renderer/Playwright Python API | `layout-config-recreation` | 1 | 35 |

Other tasks need multiple independent packages or exact external facilities; this ladder deliberately does not award them a full unblock for only one tool. In particular, `curl` (38 agent tasks), `git` (18), `tar`/`gzip`, GNU `bash`/`make`, and `sqlite3` are already covered by the browser shell or `ipk` and add **0** of the remaining 44 by themselves. The next highest-reach missing gates are local HTTP daemon fidelity (11 agent tasks), `gcc` (11), full Node process parity (8), and `torch` (7). #3642 covers WASI loopback primitives, not the benchmark services. Published [`wasi-go` and `wasi-go-std`](https://www.npmjs.com/package/@ai-ecoverse/wasi-go) provide compiler parts; the `go build` driver is planned for phase 5e. A Go compiler is verifier-only in this pinned set (`formal-crypto`), so it has no immediate agent-side marginal unlock.

## WASMaxxing coverage and boundaries

- **Merged on main:** `ipk` executable modes [#3632](https://github.com/ai-ecoverse/slicc/pull/3632), Emscripten program spawning [#3539](https://github.com/ai-ecoverse/slicc/pull/3539), loopback sockets [#3577](https://github.com/ai-ecoverse/slicc/pull/3577), HTTP proxy [#3589](https://github.com/ai-ecoverse/slicc/pull/3589), and WASI preview1 program loading [#3638](https://github.com/ai-ecoverse/slicc/pull/3638).
- **Installable via `ipk`:** `@ai-ecoverse/wasm-bash`, `wasm-coreutils`, `wasm-gmake`, `wasm-git`, `wasm-curl`, `wasm-tar`, `wasm-gzip`, `wasm-sqlite3`, and `wasi-ripgrep`; SLICC also uses `pyodide`, `@ffmpeg/core`, and `@imagemagick/magick-wasm`. The separate `wasm-ffmpeg` package was retired; do not count it as available.
- **In flight:** [#3642](https://github.com/ai-ecoverse/slicc/pull/3642) adds WASI sockets and `wasm --listen`; phase 5c targets WASIX fork/exec and Python subprocess compatibility; phase 5d targets threads; phase 5e targets a Go build driver and package wiring. `wasi-go` and `wasi-go-std` are published package components, not a validated `go build` CLI yet.
- **Hard boundary:** browser workers cannot hand a Linux verifier the same kernel processes, root privileges, `/proc`/`ptrace`, raw external sockets, Docker sidecars, CUDA devices, or architecture-specific ELF executable ABI. Those tasks need Harbor-side infrastructure or a separately defined emulated benchmark.
