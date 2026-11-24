#!/usr/bin/env python3
"""Start OneShot with the existing deployment command."""
import sys

from oneshot import app

if __name__ == "__main__":
    app.main()
else:
    # Keep legacy imports and the application on the same module state.
    sys.modules[__name__] = app
