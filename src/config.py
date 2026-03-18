"""
src/config.py — Central configuration. Import from here everywhere.
"""
import os
import discord
from dotenv import load_dotenv

load_dotenv()

# ── Absolute paths ────────────────────────────────────────────────────────────
BASE_DIR  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # project root
SRC_DIR   = os.path.join(BASE_DIR, "src")
DATA_DIR  = os.path.join(SRC_DIR,  "data")
WEB_DIR   = os.path.join(SRC_DIR,  "web", "panel")
LOGS_DIR  = os.path.join(BASE_DIR, "logs")
DB_PATH   = os.path.join(WEB_DIR,  "logs.db")

# ── Discord ───────────────────────────────────────────────────────────────────
TOKEN              : str = os.getenv("DISCORD_BOT_TOKEN", "")
SUPERUSER_ID       : int = 706932839907852389
LOG_VIEWERS        : set = {706932839907852389, 543687632551542785}
DISCONNECT_TIMEOUT : int = 420   # seconds idle before auto-leaving VC
COMMAND_PREFIX     : str = "!"

# ── Web panel ─────────────────────────────────────────────────────────────────
# If set, remote requests (non-localhost) must include ?token=<value> or X-Panel-Token header.
# Leave empty to allow open access (only safe if bound to localhost).
WEB_PANEL_TOKEN : str = os.getenv("WEB_PANEL_TOKEN", "")

# ── Spotify ───────────────────────────────────────────────────────────────────
SPOTIFY_CLIENT_ID     : str = os.getenv("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET : str = os.getenv("SPOTIFY_CLIENT_SECRET", "")

# ── Embed colors ──────────────────────────────────────────────────────────────
COLORS: dict = {
    "purple": discord.Color.from_rgb(147, 112, 219),
    "green":  discord.Color.from_rgb( 67, 181, 129),
    "red":    discord.Color.from_rgb(255,  99,  71),
    "blue":   discord.Color.from_rgb(100, 149, 237),
    "orange": discord.Color.from_rgb(255, 165,   0),
    "yellow": discord.Color.from_rgb(250, 204,  21),
    "grey":   discord.Color.from_rgb(128, 128, 128),
}
