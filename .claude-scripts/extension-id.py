#!/usr/bin/env python3
"""Print the extension ID Chrome derives for an unpacked extension directory.

Chrome does not store this anywhere readable — for an unpacked extension it is
computed from the absolute load path: SHA-256 the path, take the first 16 bytes,
and map each hex digit onto 'a'..'p'. Reproducing it here means registering the
native host needs no copy-paste from chrome://extensions, though the ID is still
printed so it can be checked against what the browser shows.

Usage: extension-id.py <absolute-path-to-unpacked-extension>
"""

import hashlib
import sys

ID_LENGTH_HEX_DIGITS = 32


def extension_id_for_path(unpacked_path: str) -> str:
    digest = hashlib.sha256(unpacked_path.encode()).hexdigest()[:ID_LENGTH_HEX_DIGITS]
    return "".join(chr(ord("a") + int(hex_digit, 16)) for hex_digit in digest)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    print(extension_id_for_path(sys.argv[1]))
