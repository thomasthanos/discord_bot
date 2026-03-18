"""
src/cogs/moderation.py
Commands: clear, wipe, addwipeuser, removewipeuser, wipeusers, logs
Also exports log_action() and _entry() used by other cogs.
"""
import asyncio
import logging
import os
import webbrowser
from datetime import datetime, timezone

import discord
from discord import Embed
from discord.ext import commands

from src.config import COLORS, DATA_DIR, LOG_VIEWERS, SUPERUSER_ID
from src.database import insert_mod_log
from src.utils.crypto import load_encrypted, load_key, save_encrypted
from src.web.app import socketio

log = logging.getLogger(__name__)

ALLOWED_USERS_FILE = os.path.join(DATA_DIR, "allowed_users.json")


# ── Shared helpers (imported by music.py, invite.py, help.py) ─────────────────

def _entry(author, content: str, embed_content: str = "") -> dict:
    return {
        "author":        str(author),
        "content":       str(content),
        "embed_content": str(embed_content),
        "timestamp":     datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
    }


def _collect_msg(msg: discord.Message) -> dict:
    content, embed_content = msg.content, ""
    if msg.embeds:
        e     = msg.embeds[0]
        parts = []
        if e.title:       parts.append(f"Title: {e.title}")
        if e.description: parts.append(f"Description: {e.description}")
        for f in e.fields: parts.append(f"{f.name}: {f.value}")
        if e.image or e.thumbnail: parts.append("[Contains image]")
        embed_content = "\n".join(parts) or "[Embed]"
        content = content or "[Embed Message]"
    return {
        "author":        str(msg.author),
        "content":       content,
        "embed_content": embed_content,
        "timestamp":     msg.created_at.strftime("%Y-%m-%d %H:%M:%S"),
    }


def log_action(server: str, user: str, channel: str, action: str, details: list) -> None:
    """Save to DB → emit SocketIO live-update. Escaping is handled by the web panel."""
    ts    = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    clean = [
        {
            "author":        str(m.get("author", "")),
            "content":       str(m.get("content", "")),
            "embed_content": str(m.get("embed_content", "")),
            "timestamp":     str(m.get("timestamp", ts)),
        }
        for m in details
    ]
    try:
        insert_mod_log(str(server), str(user), str(channel), str(action), clean, ts)
    except Exception as e:
        log.error("DB insert error: %s", e)
        return
    try:
        socketio.emit("new_log", {
            "server": str(server), "user": str(user), "channel": str(channel),
            "action": str(action), "details": clean, "timestamp": ts,
        })
    except Exception as e:
        log.error("SocketIO emit error: %s", e)


# ── Cog ───────────────────────────────────────────────────────────────────────

class ModerationCog(commands.Cog, name="Moderation"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    def _allowed(self) -> list:
        return load_encrypted(ALLOWED_USERS_FILE, load_key()) or [SUPERUSER_ID]

    def _save_allowed(self, ids: list) -> None:
        save_encrypted(ids, ALLOWED_USERS_FILE, load_key())

    # ── !clear ────────────────────────────────────────────────────────────────
    @commands.command(name="clear", aliases=["c", "ψ"])
    @commands.cooldown(1, 5, commands.BucketType.user)
    async def clear(self, ctx: commands.Context, amount: int = None):
        """Delete N messages from the channel."""
        if amount is None:
            return await ctx.send(embed=Embed(
                description=f"{ctx.author.mention} ❌ Specify a number. `!clear 10`",
                color=COLORS["red"]), delete_after=6)

        if not 1 <= amount <= 1000:
            return await ctx.send(embed=Embed(
                description="❌ Amount must be **1 – 1000**.",
                color=COLORS["red"]), delete_after=6)

        if ctx.author.id != SUPERUSER_ID and not ctx.author.guild_permissions.manage_messages:
            return await ctx.send(embed=Embed(
                description=f"{ctx.author.mention} ❌ Requires **Manage Messages**.",
                color=COLORS["red"]), delete_after=6)

        # Collect BEFORE purge; skip index 0 which is the !clear command itself
        # (purge already deletes it, and we add it separately as the action entry)
        all_msgs = [_collect_msg(m) async for m in ctx.channel.history(limit=amount + 1)]
        deleted_msgs = all_msgs[1:]   # exclude the command message from the log details

        deleted = await ctx.channel.purge(limit=amount + 1)

        await ctx.send(embed=Embed(
            description=f"🗑️ Deleted **{len(deleted)}** messages.",
            color=COLORS["green"]), delete_after=5)

        log_action(
            ctx.guild.name, str(ctx.author), ctx.channel.name, "Clear",
            [_entry(ctx.author, ctx.message.content)] + deleted_msgs,
        )

    @clear.error
    async def _clear_error(self, ctx: commands.Context, error):
        if isinstance(error, commands.CommandOnCooldown):
            await ctx.send(embed=Embed(
                description=f"⏳ Cooldown! Retry in **{error.retry_after:.1f}s**.",
                color=COLORS["orange"]), delete_after=5)

    # ── !wipe ─────────────────────────────────────────────────────────────────
    @commands.command(name="wipe", aliases=["w", "ς"])
    @commands.cooldown(1, 15, commands.BucketType.user)
    async def wipe(self, ctx: commands.Context):
        """Wipe ALL messages in the channel (confirmation required)."""
        if ctx.author.id != SUPERUSER_ID and ctx.author.id not in self._allowed():
            return await ctx.send(embed=Embed(
                title="🚫 No Access",
                description=f"Your ID `{ctx.author.id}` is not whitelisted.",
                color=COLORS["red"]))

        prompt = await ctx.send(embed=Embed(
            title="⚠️ Confirm Wipe",
            description="React ✅ to wipe **all** messages or ❌ to cancel.\nTimeout: **15s**",
            color=COLORS["orange"]))
        await prompt.add_reaction("✅")
        await prompt.add_reaction("❌")

        def _check(r, u):
            return u == ctx.author and str(r.emoji) in ("✅", "❌") and r.message.id == prompt.id

        try:
            reaction, _ = await self.bot.wait_for("reaction_add", check=_check, timeout=15)
        except asyncio.TimeoutError:
            await prompt.delete()
            return await ctx.send(embed=Embed(title="⏳ Timed out.", color=COLORS["grey"]), delete_after=5)

        await prompt.delete()
        if str(reaction.emoji) == "❌":
            return await ctx.send(embed=Embed(title="🚫 Canceled.", color=COLORS["grey"]), delete_after=5)

        msgs, deleted = [], 0
        async for m in ctx.channel.history(limit=None):
            msgs.append(_collect_msg(m))
            try:
                await m.delete()
                deleted += 1
                await asyncio.sleep(0.1)
            except discord.Forbidden:
                pass  # skip pinned or otherwise protected messages
            except discord.HTTPException as e:
                if e.status == 429:
                    await asyncio.sleep(e.retry_after or 5)
            # Flush every 200 messages to avoid RAM buildup in large channels
            if len(msgs) >= 200:
                log_action(ctx.guild.name, str(ctx.author), ctx.channel.name, "Wipe", msgs)
                msgs.clear()

        if msgs:
            log_action(ctx.guild.name, str(ctx.author), ctx.channel.name, "Wipe", msgs)
        await ctx.send(embed=Embed(
            title="✨ Done!",
            description=f"Deleted **{deleted}** messages.",
            color=COLORS["green"]))

    @wipe.error
    async def _wipe_error(self, ctx: commands.Context, error):
        if isinstance(error, commands.CommandOnCooldown):
            await ctx.send(embed=Embed(
                description=f"⏳ Cooldown! Retry in **{error.retry_after:.1f}s**.",
                color=COLORS["orange"]), delete_after=5)

    @staticmethod
    def _parse_user_id(raw: str) -> int | None:
        """Accept a @mention (<@123> or <@!123>) or a raw integer string."""
        try:
            return int(raw.strip("<@!>"))
        except (ValueError, AttributeError):
            return None

    # ── !addwipeuser ──────────────────────────────────────────────────────────
    @commands.command(name="addwipeuser", aliases=["aw", "ας"])
    async def addwipeuser(self, ctx: commands.Context, target: str = None):
        """Add a user to the wipe whitelist. (superuser only)"""
        if ctx.author.id != SUPERUSER_ID:
            return await ctx.send(embed=Embed(title="🚫 Superuser only.", color=COLORS["red"]))
        user_id = self._parse_user_id(target) if target else None
        if not user_id:
            return await ctx.send(embed=Embed(
                description="⚠️ Provide a user mention or ID.", color=COLORS["orange"]))

        ids = self._allowed()
        if user_id in ids:
            return await ctx.send(embed=Embed(
                description=f"⚠️ `{user_id}` is already whitelisted.", color=COLORS["orange"]))

        ids.append(user_id)
        self._save_allowed(ids)
        await ctx.send(embed=Embed(
            description=f"✅ `{user_id}` added to wipe whitelist.", color=COLORS["green"]))
        log_action(ctx.guild.name, str(ctx.author), ctx.channel.name, "AddWipeUser",
                   [_entry(ctx.author, f"addwipeuser {user_id}")])

    # ── !removewipeuser ───────────────────────────────────────────────────────
    @commands.command(name="removewipeuser", aliases=["rw"])
    async def removewipeuser(self, ctx: commands.Context, target: str = None):
        """Remove a user from the wipe whitelist. (superuser only)"""
        if ctx.author.id != SUPERUSER_ID:
            return await ctx.send(embed=Embed(title="🚫 Superuser only.", color=COLORS["red"]))
        user_id = self._parse_user_id(target) if target else None
        if not user_id:
            return await ctx.send(embed=Embed(
                description="⚠️ Provide a user mention or ID.", color=COLORS["orange"]))

        ids = self._allowed()
        if user_id not in ids:
            return await ctx.send(embed=Embed(
                description=f"⚠️ `{user_id}` is not in the whitelist.", color=COLORS["orange"]))

        ids.remove(user_id)
        self._save_allowed(ids)
        await ctx.send(embed=Embed(
            description=f"✅ `{user_id}` removed from wipe whitelist.", color=COLORS["green"]))

    # ── !wipeusers ────────────────────────────────────────────────────────────
    @commands.command(name="wipeusers")
    async def wipeusers(self, ctx: commands.Context):
        """List the wipe whitelist. (superuser only)"""
        if ctx.author.id != SUPERUSER_ID:
            return await ctx.send(embed=Embed(title="🚫 Superuser only.", color=COLORS["red"]))
        ids      = self._allowed()
        mentions = "\n".join(f"• <@{i}>  (`{i}`)" for i in ids) or "*(empty)*"
        await ctx.send(embed=Embed(
            title="📋 Wipe Whitelist",
            description=mentions,
            color=COLORS["blue"]))

    # ── !logs ─────────────────────────────────────────────────────────────────
    @commands.command(name="logs", aliases=["viewlogs"])
    async def logs(self, ctx: commands.Context):
        """Open the web log panel in your browser."""
        if ctx.author.id not in LOG_VIEWERS:
            return await ctx.send(embed=Embed(
                description=f"{ctx.author.mention} ❌ Not authorized.",
                color=COLORS["red"]), delete_after=5)
        try:
            webbrowser.open("http://127.0.0.1:5000")
            await ctx.send(embed=Embed(
                description=f"{ctx.author.mention} ✅ Opened log panel in browser.",
                color=COLORS["green"]), delete_after=5)
            log_action(ctx.guild.name, str(ctx.author), ctx.channel.name,
                       "ViewLogs", [_entry(ctx.author, "!logs")])
        except Exception as e:
            await ctx.send(embed=Embed(
                description=f"❌ `{e}`", color=COLORS["red"]), delete_after=5)


async def setup(bot: commands.Bot):
    await bot.add_cog(ModerationCog(bot))
