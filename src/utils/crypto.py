"""
src/utils/crypto.py — Fernet encryption for sensitive JSON data.
"""
import json
import logging
import os
from typing import Any

from cryptography.fernet import Fernet

from src.config import DATA_DIR

log = logging.getLogger(__name__)
_KEY_FILE = os.path.join(DATA_DIR, "secret.key")


def load_key() -> bytes:
    """Load the Fernet key from disk, generating one if it doesn't exist."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(_KEY_FILE):
        key = Fernet.generate_key()
        with open(_KEY_FILE, "wb") as f:
            f.write(key)
        log.info("Generated new Fernet key at %s", _KEY_FILE)
        return key
    with open(_KEY_FILE, "rb") as f:
        return f.read()


def save_encrypted(data: Any, filepath: str, key: bytes) -> None:
    """Serialise *data* to JSON, encrypt, and write to *filepath*."""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "wb") as f:
        f.write(Fernet(key).encrypt(json.dumps(data).encode()))


def load_encrypted(filepath: str, key: bytes) -> Any:
    """Read, decrypt, and deserialise JSON from *filepath*.
    Returns an empty list if the file doesn't exist."""
    try:
        with open(filepath, "rb") as f:
            return json.loads(Fernet(key).decrypt(f.read()).decode())
    except FileNotFoundError:
        return []
    except Exception as e:
        log.error("Failed to decrypt %s: %s", filepath, e)
        return []
