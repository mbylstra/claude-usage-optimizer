#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Discovers and runs every test_*.py in this directory.

`uv run --script`, not plain `python3`: the module under test
(run-autonomous-work.py) requires Python >=3.10, same as this file declares
above, while the system `python3` on a fresh Mac is often older. This mirrors
how `run-autonomous-work.py` itself is invoked — see
`backend/claude-usage-autonomous-work`.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).resolve().parent), pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
