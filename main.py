"""
main.py — Discord Bot entry point.
Run:  python main.py   or   double-click run.bat
"""
import asyncio
import logging
import signal
import sys
import threading
import time

import discord
from discord.ext import commands
from dotenv import load_dotenv

# ── Bootstrap ─────────────────────────────────────────────────────────────────
load_dotenv()

from src.utils import setup_logging
setup_logging()
log = logging.getLogger(__name__)

from src.config  import TOKEN, SUPERUSER_ID, DISCONNECT_TIMEOUT, COLORS, COMMAND_PREFIX
from src.cogs    import COGS
from src.web     import app, socketio, set_bot_client

# ── Bot ───────────────────────────────────────────────────────────────────────
intents                 = discord.Intents.default()
intents.message_content = True
intents.voice_states    = True
intents.members         = True
intents.invites         = True
intents.guilds          = True

bot            = commands.Bot(command_prefix=COMMAND_PREFIX, intents=intents, help_command=None)
bot.start_time = time.time()


# ── Events ────────────────────────────────────────────────────────────────────

@bot.event
async def on_ready():
    try:
        synced = await bot.tree.sync()
        log.info("Synced %d slash commands.", len(synced) if synced else 0)
    except Exception as e:
        log.error("Slash sync error: %s", e)

    set_bot_client(bot)
    guilds = len(bot.guilds)
    users  = sum(g.member_count for g in bot.guilds)
    print(f"[OK] {bot.user}  |  {guilds} servers  |  {users} users")
    log.info("Ready: %s | guilds=%d | users=%d", bot.user, guilds, users)
    await bot.change_presence(activity=discord.Activity(
        type=discord.ActivityType.watching, name=f"{COMMAND_PREFIX}help | /help"))


@bot.event
async def on_voice_state_update(member: discord.Member, before, after):
    # Bot was kicked from a VC
    if member == bot.user and before.channel and not after.channel:
        _clear_music(member.guild)
        loop = asyncio.get_running_loop()
        loop.create_task(_send_to_guild(member.guild, "😢 I was kicked from the voice channel!"))
        return

    # Auto-disconnect when left alone in VC
    if (before.channel
            and bot.user in before.channel.members
            and len(before.channel.members) == 1):
        await asyncio.sleep(DISCONNECT_TIMEOUT)
        vc = before.channel.guild.voice_client
        if (vc
                and before.channel
                and bot.user in before.channel.members
                and len(before.channel.members) == 1):
            try:
                await vc.disconnect()
                _clear_music(before.channel.guild)
                await _send_to_guild(before.channel.guild, "😴 Disconnected due to inactivity.")
            except Exception as e:
                log.error("Auto-disconnect error: %s", e)


def _clear_music(guild: discord.Guild):
    """Clear music state for a specific guild."""
    cog = bot.cogs.get("Music")
    if cog:
        cog._state(guild.id).clear()


async def _send_to_guild(guild: discord.Guild, text: str):
    ch = next(
        (c for c in guild.text_channels if c.permissions_for(guild.me).send_messages),
        None,
    )
    if ch:
        await ch.send(embed=discord.Embed(description=text, color=COLORS["orange"]))


@bot.event
async def on_command_error(ctx: commands.Context, error):
    if isinstance(error, commands.CommandOnCooldown):
        return await ctx.send(embed=discord.Embed(
            description=f"⏳ Cooldown! Retry in **{error.retry_after:.1f}s**.",
            color=COLORS["orange"]), delete_after=5)

    if isinstance(error, commands.MissingPermissions):
        if ctx.author.id == SUPERUSER_ID:
            return await ctx.reinvoke()
        return await ctx.send(embed=discord.Embed(
            description="❌ You don't have permission for that.",
            color=COLORS["red"]), delete_after=6)

    if isinstance(error, commands.CommandNotFound):
        return  # silently ignore

    if isinstance(error, commands.MissingRequiredArgument):
        return await ctx.send(embed=discord.Embed(
            description=f"❌ Missing argument: `{error.param.name}`. Try `!help`.",
            color=COLORS["red"]), delete_after=8)

    if isinstance(error, commands.BadArgument):
        return await ctx.send(embed=discord.Embed(
            description="❌ Bad argument. Try `!help`.",
            color=COLORS["red"]), delete_after=8)

    log.error("Unhandled error in [%s]: %s", ctx.command, error, exc_info=error)


@bot.event
async def on_app_command_error(interaction: discord.Interaction, error):
    embed = discord.Embed(description=f"❌ {error}", color=COLORS["red"])
    try:
        await interaction.response.send_message(embed=embed, ephemeral=True)
    except discord.InteractionResponded:
        try:
            await interaction.followup.send(embed=embed, ephemeral=True)
        except Exception:
            pass
    except Exception:
        pass


# ── Cog loading ───────────────────────────────────────────────────────────────

async def _load_cogs():
    for ext in COGS:
        try:
            await bot.load_extension(ext)
            log.info("  [OK] %s", ext)
            print(f"  [OK] {ext}")
        except Exception as e:
            log.error("  [FAIL] %s - %s", ext, e)
            print(f"  [FAIL] {ext} - {e}")


# ── Entry ─────────────────────────────────────────────────────────────────────

async def _run_bot():
    if not TOKEN:
        print("[ERROR] DISCORD_BOT_TOKEN is not set in .env!")
        sys.exit(1)
    print("[...] Loading cogs...")
    await _load_cogs()
    print("[...] Connecting to Discord...")
    await bot.start(TOKEN)


def _run_flask():
    socketio.run(app, host="0.0.0.0", port=5000,
                 debug=False, use_reloader=False,
                 log_output=False, allow_unsafe_werkzeug=True)


# ── Graceful shutdown ─────────────────────────────────────────────────────────

_stopping = False


async def _graceful_shutdown(task: asyncio.Task):
    print("\n[...] Shutting down...")
    task.cancel()
    try:
        await asyncio.wait_for(bot.close(), timeout=10)
    except Exception:
        pass
    asyncio.get_running_loop().stop()


def _stop(loop: asyncio.AbstractEventLoop, task: asyncio.Task):
    global _stopping
    if _stopping:
        return
    _stopping = True
    asyncio.run_coroutine_threadsafe(_graceful_shutdown(task), loop)


if __name__ == "__main__":
    loop     = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    bot_task = loop.create_task(_run_bot())

    def _on_bot_done(t: asyncio.Task):
        if not t.cancelled() and t.exception():
            log.critical("Bot task failed: %s", t.exception())
            loop.stop()
    bot_task.add_done_callback(_on_bot_done)

    threading.Thread(target=_run_flask, daemon=True).start()

    signal.signal(signal.SIGINT,  lambda s, f: _stop(loop, bot_task))
    signal.signal(signal.SIGTERM, lambda s, f: _stop(loop, bot_task))

    try:
        loop.run_forever()
    except KeyboardInterrupt:
        pass
    finally:
        pending = asyncio.all_tasks(loop)
        if pending:
            try:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            except RuntimeError:
                pass
        loop.close()
        print("[OK] Bot stopped cleanly.")
