"""Make `pipeline/` importable so tests can `import enrich` / `import cluster`."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
