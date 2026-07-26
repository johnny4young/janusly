"""Build and import the real Python distribution without publishing it."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> None:
    package_root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="janusly-python-package-") as temp_raw:
        temp = Path(temp_raw)
        dist = temp / "dist"
        target = temp / "consumer"
        subprocess.run(
            ["uv", "build", "--out-dir", str(dist)],
            cwd=package_root,
            check=True,
        )
        wheels = list(dist.glob("janusly-*.whl"))
        source_distributions = list(dist.glob("janusly-*.tar.gz"))
        if len(wheels) != 1 or len(source_distributions) != 1:
            raise RuntimeError("expected one wheel and one source distribution")

        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-deps",
                "--no-index",
                "--target",
                str(target),
                str(wheels[0]),
            ],
            check=True,
        )
        env = {**os.environ, "PYTHONPATH": str(target)}
        subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "from pathlib import Path; "
                    "import janusly; "
                    "from janusly import JanuslyProtocolError; "
                    f"assert Path(janusly.__file__).is_relative_to(Path({str(target)!r})); "
                    "assert JanuslyProtocolError.__name__ == 'JanuslyProtocolError'; "
                    "print('Python SDK wheel import OK')"
                ),
            ],
            cwd=temp,
            env=env,
            check=True,
        )


if __name__ == "__main__":
    main()
