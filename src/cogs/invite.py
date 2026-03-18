"""
src/cogs/invite.py
Events:  on_ready, on_guild_join, on_member_join, on_member_remove,
         on_invite_create, on_invite_delete
Commands: setinvitechannel, invitestats, topinviters, addinvitelog
"""
import asyncio
import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Optional

import discord
from discord import Embed, Invite, Member, TextChannel
from discord.ext import commands, tasks

from src.config import COLORS, DATA_DIR
from src.database import insert_invite_log
from src.web.app import socketio

log = logging.getLogger(__name__)

_INVITE_DATA  = os.path.join(DATA_DIR, "invite_data.json")
_MEMBER_DATA  = os.path.join(DATA_DIR, "member_invite_data.json")
_CHANNEL_FILE = os.path.join(DATA_DIR, "invite_channel.json")

# Per-guild asyncio locks — prevent race conditions when multiple members join simultaneously
# Use a threading lock to protect the dict itself
_locks_mutex: threading.Lock       = threading.Lock()
_guild_locks: dict[int, asyncio.Lock] = {}


def _guild_lock(guild_id: int) -> asyncio.Lock:
    with _locks_mutex:
        if guild_id not in _guild_locks:
            _guild_locks[guild_id] = asyncio.Lock()
        return _guild_locks[guild_id]


def _cleanup_guild_lock(guild_id: int) -> None:
    """Remove the lock for a guild we've left — prevents memory leak."""
    with _locks_mutex:
        _guild_locks.pop(guild_id, None)


# ── JSON helpers (protected by threading lock for concurrent writes) ──────────
_json_lock = threading.Lock()


def _rj(path: str, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default if default is not None else {}


def _wj(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _json_lock:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)


# ── Cog ───────────────────────────────────────────────────────────────────────

class InviteCog(commands.Cog, name="Invite"):
    def __init__(self, bot: commands.Bot):
        self.bot         = bot
        self.cache: dict = {}   # invite_code → uses
        self.log_ch_id: Optional[int] = _rj(_CHANNEL_FILE, {}).get("channel_id")
        # In-memory write buffers — flushed to disk every 30 s instead of on every event
        self._invite_buf: dict = _rj(_INVITE_DATA, {})
        self._member_buf: dict = _rj(_MEMBER_DATA, {})
        self._buf_dirty:  bool = False
        self._flush_loop.start()
        log.info("Invite log channel: %s", self.log_ch_id)

    def cog_unload(self):
        self._flush_loop.cancel()
        self._flush_to_disk()   # final synchronous flush on unload

    @tasks.loop(seconds=30)
    async def _flush_loop(self):
        self._flush_to_disk()

    def _flush_to_disk(self):
        if not self._buf_dirty:
            return
        self._buf_dirty = False
        with _json_lock:
            os.makedirs(os.path.dirname(_INVITE_DATA), exist_ok=True)
            with open(_INVITE_DATA, "w", encoding="utf-8") as f:
                json.dump(self._invite_buf, f, indent=4, ensure_ascii=False)
        with _json_lock:
            os.makedirs(os.path.dirname(_MEMBER_DATA), exist_ok=True)
            with open(_MEMBER_DATA, "w", encoding="utf-8") as f:
                json.dump(self._member_buf, f, indent=4, ensure_ascii=False)

    # ── JSON helpers ──────────────────────────────────────────────────────────

    def _inviter_stats(self, uid: int) -> dict:
        return self._invite_buf.get(str(uid), {"invites": 0, "last_invite": []})

    def _bump_inviter(self, member_id: int, inviter_id: int) -> None:
        s = self._invite_buf.get(str(inviter_id), {"invites": 0, "last_invite": []})
        if not isinstance(s, dict):
            s = {"invites": 0, "last_invite": []}
        s["invites"] = s.get("invites", 0) + 1
        s["last_invite"].append(str(member_id))
        s["last_invite"] = s["last_invite"][-50:]
        self._invite_buf[str(inviter_id)] = s
        self._buf_dirty = True

    def _member_info(self, mid: int) -> dict:
        return self._member_buf.get(str(mid), {})

    def _save_member(self, mid: int, info: dict) -> None:
        self._member_buf[str(mid)] = info
        self._buf_dirty = True

    def _save_channel(self, cid: int) -> None:
        _wj(_CHANNEL_FILE, {"channel_id": cid})
        self.log_ch_id = cid

    # ── DB + SocketIO ─────────────────────────────────────────────────────────

    def _db_log(self, **kw) -> None:
        try:
            insert_invite_log(**kw)
        except Exception as e:
            log.error("DB invite log: %s", e)
        try:
            socketio.emit("new_invite_log", {
                "event_type":     kw["event_type"],
                "member":         kw["member"],
                "discord_id":     kw["discord_id"],
                "inviter":        kw["inviter"],
                "invite_code":    kw["invite_code"],
                "max_uses":       str(kw["max_uses"]) if kw["max_uses"] > 0 else "Unlimited",
                "uses":           str(kw["uses"]),
                "is_temporary":   "Yes" if kw["is_temporary"] else "No",
                "expires_at":     kw["expires_at"],
                "timestamp":      kw["timestamp"],
                "server":         kw["server"],
                "inviter_role":   kw["inviter_role"],
                "source":         kw["source"],
                "join_method":    kw["join_method"],
                "notes":          kw["notes"],
                "invite_created": kw["invite_created"],
            })
        except Exception as e:
            log.error("SocketIO invite: %s", e)

    async def _send_log(self, embed: Embed) -> None:
        if not self.log_ch_id:
            return
        ch = self.bot.get_channel(self.log_ch_id)
        if ch:
            await ch.send(embed=embed)
        else:
            log.warning("Invite log channel %d not found or bot has no access.", self.log_ch_id)

    async def _cache_guild(self, guild: discord.Guild) -> None:
        try:
            for inv in await guild.invites():
                self.cache[inv.code] = inv.uses
        except Exception:
            pass

    # ── Events ────────────────────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_ready(self):
        await asyncio.gather(*[self._cache_guild(g) for g in self.bot.guilds], return_exceptions=True)
        log.info("Invite cache ready: %d codes", len(self.cache))

    @commands.Cog.listener()
    async def on_guild_join(self, guild: discord.Guild):
        await self._cache_guild(guild)

    @commands.Cog.listener()
    async def on_guild_remove(self, guild: discord.Guild):
        # Clean up the lock to prevent memory leak
        _cleanup_guild_lock(guild.id)

    @commands.Cog.listener()
    async def on_invite_create(self, invite: Invite):
        self.cache[invite.code] = invite.uses or 0

    @commands.Cog.listener()
    async def on_invite_delete(self, invite: Invite):
        self.cache.pop(invite.code, None)

    @commands.Cog.listener()
    async def on_member_join(self, member: Member):
        async with _guild_lock(member.guild.id):
            await self._handle_join(member)

    async def _handle_join(self, member: Member):
        log.info("Join: %s (%s)", member, member.id)

        guild_invites = []
        try:
            guild_invites = await member.guild.invites()
        except Exception:
            pass

        inviter        = None
        invite_code    = None
        max_uses       = 0
        uses           = 0
        expires_at     = "Never"
        is_temporary   = False
        inviter_role   = "-"
        invite_created = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        for inv in guild_invites:
            if (inv.uses or 0) > self.cache.get(inv.code, 0):
                # Update cache immediately so a concurrent join handler won't re-match this invite
                self.cache[inv.code] = inv.uses or 0
                inviter        = inv.inviter
                invite_code    = inv.code
                max_uses       = inv.max_uses or 0
                uses           = inv.uses or 0
                is_temporary   = inv.temporary
                expires_at     = inv.expires_at.strftime("%Y-%m-%d %H:%M:%S") if inv.expires_at else "Never"
                invite_created = inv.created_at.strftime("%Y-%m-%d %H:%M:%S") if inv.created_at else invite_created
                if inviter:
                    try:
                        gm    = member.guild.get_member(inviter.id) or await member.guild.fetch_member(inviter.id)
                        roles = [r for r in gm.roles if r.name != "@everyone"]
                        inviter_role = max(roles, key=lambda r: r.position).name if roles else "-"
                    except discord.NotFound:
                        inviter_role = "Left server"
                break

        # Refresh cache after finding the used invite
        for inv in guild_invites:
            self.cache[inv.code] = inv.uses or 0

        if inviter:
            self._bump_inviter(member.id, inviter.id)

        self._save_member(member.id, {
            "inviter":       str(inviter) if inviter else "Unknown",
            "invite_code":   invite_code or "Unknown",
            "max_uses":      max_uses, "uses": uses,
            "expires_at":    expires_at, "is_temporary": is_temporary,
            "inviter_role":  inviter_role, "source": "Direct Link",
            "join_method":   "Invite Link", "invite_created": invite_created,
        })

        stats  = self._inviter_stats(inviter.id if inviter else 0)
        recent = ", ".join(f"<@{u}>" for u in stats["last_invite"][-5:]) or "None"

        embed = Embed(
            title="📥 Member Joined",
            description=f"{member.mention} was invited by {inviter.mention if inviter else '**Unknown**'}",
            color=COLORS["green"])
        embed.set_thumbnail(url=member.display_avatar.url)
        embed.add_field(name="Member",       value=f"{member}  (`{member.id}`)", inline=False)
        embed.add_field(name="Code",         value=f"`{invite_code}`" if invite_code else "Unknown", inline=True)
        embed.add_field(name="Uses",         value=f"{uses} / {'∞' if not max_uses else max_uses}", inline=True)
        embed.add_field(name="Expires",      value=expires_at,   inline=True)
        embed.add_field(name="Temporary",    value="Yes" if is_temporary else "No", inline=True)
        embed.add_field(name="Inviter Role", value=inviter_role,  inline=True)
        embed.add_field(name="Total invites by them", value=str(stats["invites"]), inline=True)
        embed.add_field(name="Their recent invites",  value=recent, inline=False)
        embed.set_footer(text=member.guild.name)
        embed.timestamp = discord.utils.utcnow()
        await self._send_log(embed)

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        self._db_log(
            event_type="Join", member=str(member), discord_id=str(member.id),
            inviter=str(inviter) if inviter else "Unknown",
            invite_code=invite_code or "Unknown",
            max_uses=max_uses, uses=uses, expires_at=expires_at,
            is_temporary=is_temporary, timestamp=ts,
            server=member.guild.name, inviter_role=inviter_role,
            source="Direct Link", join_method="Invite Link",
            notes="", invite_created=invite_created,
        )

    @commands.Cog.listener()
    async def on_member_remove(self, member: Member):
        if member.bot:
            return
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        d  = self._member_info(member.id)

        embed = Embed(
            title="📤 Member Left",
            description=f"{member.mention} left the server.",
            color=COLORS["red"])
        embed.set_thumbnail(url=member.display_avatar.url)
        embed.add_field(name="Member",       value=f"{member}  (`{member.id}`)", inline=False)
        embed.add_field(name="Invited By",   value=d.get("inviter",     "N/A"), inline=True)
        embed.add_field(name="Invite Code",  value=d.get("invite_code", "N/A"), inline=True)
        embed.add_field(name="Inviter Role", value=d.get("inviter_role","N/A"), inline=True)
        embed.set_footer(text=member.guild.name)
        embed.timestamp = discord.utils.utcnow()
        await self._send_log(embed)

        mu = int(d.get("max_uses") or 0)
        u  = int(d.get("uses")     or 0)
        self._db_log(
            event_type="Leave", member=str(member), discord_id=str(member.id),
            inviter=d.get("inviter","N/A"), invite_code=d.get("invite_code","N/A"),
            max_uses=mu, uses=u, expires_at=d.get("expires_at","Never"),
            is_temporary=bool(d.get("is_temporary",False)), timestamp=ts,
            server=member.guild.name, inviter_role=d.get("inviter_role","N/A"),
            source=d.get("source","N/A"), join_method=d.get("join_method","N/A"),
            notes="", invite_created=d.get("invite_created","N/A"),
        )

    # ── Commands ──────────────────────────────────────────────────────────────

    @commands.command(name="setinvitechannel")
    @commands.has_permissions(administrator=True)
    async def set_invite_channel(self, ctx: commands.Context, channel: TextChannel):
        """Set the channel where join/leave invite logs are posted."""
        self._save_channel(channel.id)
        await ctx.send(embed=Embed(
            description=f"✅ Invite log channel → {channel.mention}", color=COLORS["green"]))

    @commands.command(name="invitestats")
    async def invitestats(self, ctx: commands.Context, member: discord.Member = None):
        """Show invite stats for a member (defaults to yourself)."""
        target = member or ctx.author
        stats  = self._inviter_stats(target.id)
        last   = ", ".join(f"<@{u}>" for u in stats["last_invite"][-5:]) or "None"
        embed  = Embed(title=f"📊 Invite Stats — {target.display_name}", color=COLORS["blue"])
        embed.set_thumbnail(url=target.display_avatar.url)
        embed.add_field(name="Total Invites",  value=str(stats["invites"]), inline=True)
        embed.add_field(name="Last 5 Invited", value=last,                  inline=False)
        await ctx.send(embed=embed)

    @commands.command(name="topinviters")
    async def topinviters(self, ctx: commands.Context, limit: int = 10):
        """Show the top inviters leaderboard."""
        data  = _rj(_INVITE_DATA, {})
        valid = {
            uid: stats for uid, stats in data.items()
            if isinstance(stats, dict) and "invites" in stats
        }
        items = sorted(valid.items(), key=lambda x: x[1].get("invites", 0), reverse=True)[:limit]
        if not items:
            return await ctx.send(embed=Embed(
                description="No invite data yet.", color=COLORS["orange"]))
        lines = [
            f"`{i+1}.` <@{uid}> — **{s.get('invites', 0)}** invites"
            for i, (uid, s) in enumerate(items)
        ]
        await ctx.send(embed=Embed(
            title=f"🏆 Top {limit} Inviters",
            description="\n".join(lines),
            color=COLORS["yellow"]))

    @commands.command(name="addinvitelog")
    @commands.has_permissions(administrator=True)
    async def add_invite_log(
        self, ctx: commands.Context,
        member: discord.Member, inviter: discord.Member, invite_code: str,
    ):
        """Manually add an invite log entry."""
        ts    = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        roles = [r for r in inviter.roles if r.name != "@everyone"]
        role  = max(roles, key=lambda r: r.position).name if roles else "-"
        self._db_log(
            event_type="Join", member=str(member), discord_id=str(member.id),
            inviter=str(inviter), invite_code=invite_code, max_uses=0, uses=0,
            expires_at="Never", is_temporary=False, timestamp=ts,
            server=ctx.guild.name, inviter_role=role,
            source="Manual", join_method="Manual", notes="Manual entry", invite_created=ts,
        )
        await ctx.send(embed=Embed(
            description="✅ Manual invite log added.", color=COLORS["green"]))


async def setup(bot: commands.Bot):
    await bot.add_cog(InviteCog(bot))
