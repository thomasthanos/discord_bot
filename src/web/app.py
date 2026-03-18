"""
src/web/app.py — Flask + SocketIO web server.
Serves the log panel from src/web/panel/ and exposes REST + WebSocket endpoints.
"""
import logging
import os
import time

from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit

from src.config import WEB_DIR, WEB_PANEL_TOKEN
from src.database import (
    delete_invite_logs, delete_mod_logs,
    get_invite_logs, get_mod_logs,
)

log = logging.getLogger(__name__)

app      = Flask(__name__, static_folder=None, template_folder=None)
socketio = SocketIO(app, cors_allowed_origins="*", ping_interval=10, ping_timeout=5)

_bot = None


def set_bot_client(client) -> None:
    global _bot
    _bot = client


def _is_local() -> bool:
    return request.remote_addr in ("127.0.0.1", "::1")


def _is_authorized() -> bool:
    """Allow localhost always. Remote requests require a valid WEB_PANEL_TOKEN."""
    if _is_local():
        return True
    if not WEB_PANEL_TOKEN:
        return False  # no token set → block all remote access
    token = request.args.get("token") or request.headers.get("X-Panel-Token", "")
    return token == WEB_PANEL_TOKEN


# ── Pages ─────────────────────────────────────────────────────────────────────

def _UNAUTH(): return jsonify({"error": "Unauthorized"}), 401


@app.route("/")
def index():
    if not _is_authorized(): return _UNAUTH()
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/invite_logs")
def invite_logs_page():
    if not _is_authorized(): return _UNAUTH()
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/static/<path:filename>")
def serve_static(filename):
    if not _is_authorized(): return _UNAUTH()
    return send_from_directory(os.path.join(WEB_DIR, "static"), filename)


@app.route("/<path:filename>")
def serve_panel_file(filename):
    if not _is_authorized(): return _UNAUTH()
    return send_from_directory(WEB_DIR, filename)


# ── REST API ──────────────────────────────────────────────────────────────────

@app.route("/bot_status")
def bot_status():
    if not _is_authorized(): return _UNAUTH()
    if _bot and _bot.is_ready():
        up   = int(time.time() - _bot.start_time)
        d, r = divmod(up, 86400)
        h, r = divmod(r, 3600)
        m, s = divmod(r, 60)
        return jsonify({
            "online":  True,
            "uptime":  f"{d}d {h}h {m}m {s}s",
            "servers": len(_bot.guilds),
            "users":   sum(g.member_count for g in _bot.guilds),
        })
    return jsonify({"online": False, "uptime": "N/A", "servers": 0, "users": 0})


@app.route("/api/logs")
def api_logs():
    if not _is_authorized(): return _UNAUTH()
    return jsonify(get_mod_logs(500))


@app.route("/api/invite_logs")
def api_invite_logs():
    if not _is_authorized(): return _UNAUTH()
    return jsonify(get_invite_logs(500))


@app.route("/api/bot_info")
def api_bot_info():
    if not _is_authorized(): return _UNAUTH()
    if not _bot or not _bot.is_ready():
        return jsonify({})
    u = _bot.user
    return jsonify({
        "name":   str(u),
        "avatar": str(u.avatar.url) if u.avatar else None,
        "id":     u.id,
    })


@app.route("/api/guilds")
def api_guilds():
    if not _is_authorized(): return _UNAUTH()
    if not _bot or not _bot.is_ready():
        return jsonify([])
    guilds = []
    for g in sorted(_bot.guilds, key=lambda x: x.name.lower()):
        guilds.append({
            "id":      g.id,
            "name":    g.name,
            "icon":    str(g.icon.url) if g.icon else None,
            "members": g.member_count or 0,
        })
    return jsonify(guilds)


@app.route("/api/music")
def api_music():
    if not _is_authorized(): return _UNAUTH()
    if not _bot or not _bot.is_ready():
        return jsonify([])
    music_cog = _bot.cogs.get("Music")
    if not music_cog:
        return jsonify([])
    result = []
    for guild_id, gs in music_cog._guild_states.items():
        guild = _bot.get_guild(guild_id)
        if not guild:
            continue
        try:
            np = gs.now_playing
            vc = guild.voice_client
            playing = bool(np) and vc is not None and (vc.is_playing() or vc.is_paused())
            position = 0
            if playing and gs.play_start:
                import time as _t
                elapsed = int(_t.time() - gs.play_start)
                position = min(elapsed, np.duration) if np and np.duration else elapsed
            result.append({
                "guild_id":  str(guild_id),
                "guild":     guild.name,
                "playing":   playing,
                "paused":    vc.is_paused() if vc else False,
                "title":     np.title       if np else None,
                "url":       np.webpage_url if np else None,
                "thumbnail": np.thumbnail   if np else None,
                "duration":  np.duration    if np else 0,
                "position":  position,
                "volume":    round(getattr(np, "volume", 0.5) * 100) if np else 50,
                "loop":      gs.loop_mode,
                "queue":     [{"title": s.get("title","?"), "duration": s.get("duration",0)}
                               for s in list(gs.queue)],
            })
        except Exception as e:
            log.error("api_music guild %s: %s", guild_id, e)
    return jsonify(result)


@app.route("/api/music/<string:guild_id>/<action>", methods=["POST"])
def api_music_action(guild_id, action):
    if not _is_authorized(): return _UNAUTH()
    if not _bot or not _bot.is_ready():
        return jsonify({"error": "Bot not ready"}), 503
    music_cog = _bot.cogs.get("Music")
    if not music_cog:
        return jsonify({"error": "Music cog not loaded"}), 503
    try:
        gid = int(guild_id)
    except ValueError:
        return jsonify({"error": "Invalid guild_id"}), 400
    guild = _bot.get_guild(gid)
    if not guild:
        return jsonify({"error": "Guild not found"}), 404
    vc = guild.voice_client
    gs = music_cog._guild_states.get(gid)
    if action == "pause":
        if vc and vc.is_playing(): vc.pause()
    elif action == "resume":
        if vc and vc.is_paused(): vc.resume()
    elif action == "skip":
        if vc: vc.stop()
    elif action == "stop":
        import asyncio
        if vc:
            asyncio.run_coroutine_threadsafe(vc.disconnect(), _bot.loop)
    elif action == "shuffle":
        if gs:
            import random
            q = list(gs.queue)
            random.shuffle(q)
            gs.queue.clear()
            gs.queue.extend(q)
    elif action == "loop":
        if gs:
            gs.loop_mode = not gs.loop_mode
    elif action == "volume":
        data = request.get_json(silent=True) or {}
        level = max(0, min(100, int(data.get("level", 50))))
        if vc and vc.source:
            vc.source.volume = level / 100
    else:
        return jsonify({"error": "Unknown action"}), 400
    return jsonify({"status": "ok"})


@app.route("/delete", methods=["POST"])
def delete_logs():
    if not _is_local():
        return jsonify({"status": "error", "message": "Forbidden"}), 403
    try:
        delete_mod_logs()
        socketio.emit("logs_cleared", {})
        return jsonify({"status": "success"}), 200
    except Exception as e:
        log.error("delete_logs: %s", e)
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/delete_invite_logs", methods=["POST"])
def delete_invite_logs_route():
    if not _is_local():
        return jsonify({"status": "error", "message": "Forbidden"}), 403
    try:
        delete_invite_logs()
        socketio.emit("invite_logs_cleared", {})
        return jsonify({"status": "success", "message": "Invite logs deleted"}), 200
    except Exception as e:
        log.error("delete_invite_logs: %s", e)
        return jsonify({"status": "error", "message": str(e)}), 500


# ── WebSocket ─────────────────────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    emit("status", {"message": "Connected"})


@socketio.on("disconnect")
def on_disconnect():
    pass
