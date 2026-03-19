import os
import discord
import time
import logging
import asyncio
import signal
import sys
import threading
from discord.ext import commands
from colorama import init, Fore, Style
from config import FALLBACK_TOKEN, SUPERUSER_ID, DISCONNECT_TIMEOUT, COLORS
from music import setup_music
from moderation import setup_moderation
from utils import last_command_channel
from app import app, set_bot_client
from help import setup_help

# Initialize colorama for colored console output
init()

# Initialize intents
intents = discord.Intents.default()
intents.message_content = True
intents.voice_states = True
intents.members = True
intents.invites = True
intents.guilds = True

# Logging setup, showing INFO level
logging.basicConfig(
    level=logging.INFO,  # Changed from ERROR to INFO to show more logs
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logging.getLogger('discord').setLevel(logging.CRITICAL)  # Suppress discord.py logs

# Initialize bot
bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)
start_time = time.time()
bot.start_time = start_time

# Flask server function
def run_flask():
    app.run(debug=False, host='0.0.0.0', port=5000, use_reloader=False)  # Debug off to reduce output

# Bot startup
@bot.event
async def on_ready():
    await bot.tree.sync()
    print(f"{Fore.GREEN}Bot {bot.user} is online!{Style.RESET_ALL}")
    await bot.change_presence(activity=discord.Activity(type=discord.ActivityType.watching, name="!help | /βοήθεια"))
    set_bot_client(bot)  # Αυτό πρέπει να δουλεύει

# Voice state update (unchanged from your code)
@bot.event
async def on_voice_state_update(member, before, after):
    global last_command_channel
    from music import music_queue, currently_playing, currently_playing_idle_music
    if member == bot.user and before.channel and not after.channel and not bot.voice_clients:
        channel = last_command_channel or next((c for c in member.guild.text_channels if c.permissions_for(member.guild.me).send_messages), None)
        if channel:
            await channel.send(embed=discord.Embed(description="😢 I was kicked...", color=COLORS["orange"]))
        music_queue.clear()
        currently_playing = None
        currently_playing_idle_music = None
        return
    if bot.user in (before.channel.members if before.channel else []) and len(before.channel.members) == 1:
        await asyncio.sleep(DISCONNECT_TIMEOUT)
        if before.channel and bot.user in before.channel.members and len(before.channel.members) == 1:
            try:
                await before.channel.guild.voice_client.disconnect()
                music_queue.clear()
                currently_playing = None
                currently_playing_idle_music = None
                channel = last_command_channel or next((c for c in before.channel.guild.text_channels if c.permissions_for(member.guild.me).send_messages), None)
                if channel:
                    await channel.send(embed=discord.Embed(description="😴 Disconnected due to inactivity!", color=COLORS["orange"]))
            except Exception as e:
                logging.error(f"Error disconnecting: {e}")

# Command error handling (unchanged)
@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.MissingPermissions) and ctx.author.id == SUPERUSER_ID:
        await ctx.reinvoke()
    elif isinstance(error, commands.CommandNotFound):
        await ctx.send(embed=discord.Embed(description=f"❌ Command `{ctx.message.content}` not found! Try `!help`.", color=COLORS["red"]), delete_after=10)
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(embed=discord.Embed(description=f"❌ Missing required argument: `{error.param.name}`. Usage: `!{ctx.command.name} #channel-name`.", color=COLORS["red"]), delete_after=10)
    else:
        logging.error(f"Unhandled error in command {ctx.command}: {error}")
        raise error

# Async setup function
async def setup(bot):
    await setup_music(bot)
    setup_moderation(bot)
    setup_help(bot)
    try:
        await bot.load_extension("invite")
    except Exception as e:
        logging.error(f"Failed to load invite cog: {e}")

async def main():
    TOKEN = os.getenv("DISCORD_BOT_TOKEN", FALLBACK_TOKEN)
    print(f"{Fore.YELLOW}Bot is starting...{Style.RESET_ALL}")
    await setup(bot)
    await bot.start(TOKEN)

# Shutdown function
async def shutdown():
    await bot.close()

# Signal handler for graceful shutdown
is_shutting_down = False

def shutdown_handler(signum, frame, loop, bot_task):
    global is_shutting_down
    if is_shutting_down:
        return
    is_shutting_down = True
    asyncio.run_coroutine_threadsafe(shutdown(), loop)
    bot_task.cancel()
    loop.stop()

if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    bot_task = loop.create_task(main())
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()

    signal.signal(signal.SIGINT, lambda s, f: shutdown_handler(s, f, loop, bot_task))

    try:
        loop.run_forever()
    except KeyboardInterrupt:
        pass

    pending = asyncio.all_tasks(loop)
    if pending:
        try:
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        except RuntimeError:
            pass
    loop.close()
    print(f"{Fore.GREEN}Bot shut down successfully.{Style.RESET_ALL}")