"""
src/utils/logger.py — Centralised logging setup with rotation.
Call setup_logging() once at startup before importing anything else.
"""
import logging
import os
from logging.handlers import RotatingFileHandler

from src.config import LOGS_DIR

_SILENT = ("discord", "flask", "werkzeug", "engineio", "socketio", "urllib3", "spotipy")


def setup_logging(level: int = logging.INFO) -> None:
    os.makedirs(LOGS_DIR, exist_ok=True)

    fmt         = logging.Formatter(
        "%(asctime)s [%(levelname)-8s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    stream_h    = logging.StreamHandler()
    stream_h.setFormatter(fmt)

    file_h = RotatingFileHandler(
        os.path.join(LOGS_DIR, "bot.log"),
        maxBytes=5 * 1024 * 1024,   # 5 MB
        backupCount=3,
        encoding="utf-8",
    )
    file_h.setFormatter(fmt)

    # Configure the root logger directly — basicConfig is ignored if
    # logging has already been touched by any import (discord.py, etc.)
    root = logging.getLogger()
    root.setLevel(level)
    if not root.handlers:
        root.addHandler(stream_h)
        root.addHandler(file_h)
    else:
        # Replace any existing handlers with ours
        root.handlers.clear()
        root.addHandler(stream_h)
        root.addHandler(file_h)

    for lib in _SILENT:
        logging.getLogger(lib).setLevel(logging.CRITICAL)
