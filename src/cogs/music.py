"""
src/cogs/music.py
Commands: join, leave, play, pause, resume, stop, skip, remove,
          queue, nowplaying, volume, shuffle, loop, idlemusic
All commands are hybrid (prefix + slash).
State is per-guild so the bot works correctly across multiple servers.
"""
import asyncio
import logging
import os
import random
import sys
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import discord
import yt_dlp
from discord import Embed, app_commands
from discord.ext import commands
from discord.ui import Button, View

try:
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials
    _SPOTIPY_AVAILABLE = True
except ImportError:
    spotipy = None
    SpotifyClientCredentials = None
    _SPOTIPY_AVAILABLE = False

from src.config import COLORS, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
from src.cogs.moderation import _entry, log_action

log = logging.getLogger(__name__)

# ── FFmpeg path (works both as script and PyInstaller exe) ────────────────────
_BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
_FFMPEG_EXE = os.path.join(_BASE, "ffmpeg", "ffmpeg.exe")
if not os.path.isfile(_FFMPEG_EXE):
    _FFMPEG_EXE = "ffmpeg"  # fallback to system PATH

# ── yt-dlp ────────────────────────────────────────────────────────────────────
_YTDL_OPTS = {
    "format":             "bestaudio/best",
    "restrictfilenames":  True,
    "noplaylist":         True,
    "nocheckcertificate": True,
    "ignoreerrors":       False,
    "logtostderr":        False,
    "quiet":              True,
    "no_warnings":        True,
    "default_search":     "auto",
    "source_address":     "0.0.0.0",
}
_FFMPEG_OPTS = {
    "before_options": "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
    "options": "-vn",
}

# ── Spotify ───────────────────────────────────────────────────────────────────
_sp = None
if _SPOTIPY_AVAILABLE and SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET:
    try:
        _sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
            client_id=SPOTIFY_CLIENT_ID,
            client_secret=SPOTIFY_CLIENT_SECRET,
        ))
        log.info("Spotify client ready.")
    except Exception as e:
        log.warning("Spotify init failed: %s", e)


def _resolve_query(query: str) -> str:
    """Convert Spotify track URL → search string; pass everything else through."""
    if "youtube.com" in query or "youtu.be" in query:
        return query
    if "spotify.com/track" in query and _sp:
        try:
            tid   = query.split("track/")[-1].split("?")[0]
            track = _sp.track(tid)
            return f"{track['name']} {track['artists'][0]['name']}"
        except Exception:
            pass
    return query


# ── Per-guild state ───────────────────────────────────────────────────────────
@dataclass
class GuildState:
    queue:       deque = field(default_factory=deque)
    now_playing: Optional["YTDLSource"] = None
    loop_mode:   bool  = False
    play_lock:   asyncio.Lock = field(default_factory=asyncio.Lock)
    play_start:  float = field(default=0.0)   # time.time() when current track started

    def clear(self):
        self.queue.clear()
        self.now_playing = None
        self.loop_mode   = False
        self.play_start  = 0.0


# ── Audio source ──────────────────────────────────────────────────────────────
class YTDLSource(discord.PCMVolumeTransformer):
    def __init__(self, source, *, data: dict, volume: float = 0.5):
        super().__init__(source, volume)
        self.data        = data
        self.title       = data.get("title", "Unknown")
        self.url         = data.get("url", "")
        self.webpage_url = data.get("webpage_url", "")
        self.thumbnail   = data.get("thumbnail", "")
        self.duration    = data.get("duration", 0) or 0

    @classmethod
    async def from_url(cls, url: str, *, stream: bool = True) -> "YTDLSource":
        """Extract audio info and return a playable source."""
        loop = asyncio.get_running_loop()
        opts = {**_YTDL_OPTS, "extract_flat": False}

        def _extract():
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=not stream)
                if "entries" in info:
                    entries = info["entries"]
                    if not entries:
                        raise ValueError("No entries found for URL")
                    info = entries[0]
                # Get filename while ydl is still in scope
                filename = info["url"] if stream else ydl.prepare_filename(info)
                return info, filename

        data, filename = await asyncio.wait_for(loop.run_in_executor(None, _extract), timeout=30)
        return cls(discord.FFmpegPCMAudio(filename, executable=_FFMPEG_EXE, **_FFMPEG_OPTS), data=data)

    @staticmethod
    def fmt_duration(secs: int) -> str:
        if not secs:
            return "🔴 Live"
        m, s = divmod(int(secs), 60)
        h, m = divmod(m, 60)
        return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


# ── Control view ──────────────────────────────────────────────────────────────
class MusicControlView(View):
    def __init__(self, cog: "MusicCog" = None, guild_id: int = 0, *, timeout: float | None = None):
        super().__init__(timeout=timeout)
        self.cog      = cog
        self.guild_id = guild_id

    def _get_cog(self, interaction: discord.Interaction) -> "MusicCog | None":
        return self.cog or interaction.client.cogs.get("Music")

    @discord.ui.button(emoji="⏸", label="Pause",  style=discord.ButtonStyle.primary,   custom_id="mc_pause")
    async def _pause(self, interaction: discord.Interaction, _: Button):
        vc = interaction.guild.voice_client
        if vc and vc.is_playing():
            vc.pause()
            await interaction.response.send_message(
                embed=Embed(description="⏸️ Paused.", color=COLORS["blue"]), ephemeral=True)
        else:
            await interaction.response.send_message(
                embed=Embed(description="Nothing is playing.", color=COLORS["grey"]), ephemeral=True)

    @discord.ui.button(emoji="▶", label="Resume", style=discord.ButtonStyle.success,   custom_id="mc_resume")
    async def _resume(self, interaction: discord.Interaction, _: Button):
        vc = interaction.guild.voice_client
        if vc and vc.is_paused():
            vc.resume()
            await interaction.response.send_message(
                embed=Embed(description="▶️ Resumed.", color=COLORS["green"]), ephemeral=True)
        else:
            await interaction.response.send_message(
                embed=Embed(description="Not paused.", color=COLORS["grey"]), ephemeral=True)

    @discord.ui.button(emoji="⏭", label="Skip",   style=discord.ButtonStyle.secondary, custom_id="mc_skip")
    async def _skip(self, interaction: discord.Interaction, _: Button):
        vc = interaction.guild.voice_client
        if vc and (vc.is_playing() or vc.is_paused()):
            vc.stop()
            await interaction.response.send_message(
                embed=Embed(description="⏭️ Skipped.", color=COLORS["green"]), ephemeral=True)
        else:
            await interaction.response.send_message(
                embed=Embed(description="Nothing to skip.", color=COLORS["grey"]), ephemeral=True)

    @discord.ui.button(emoji="🛑", label="Stop",  style=discord.ButtonStyle.danger,    custom_id="mc_stop")
    async def _stop(self, interaction: discord.Interaction, _: Button):
        vc = interaction.guild.voice_client
        if vc:
            vc.stop()
            cog = self._get_cog(interaction)
            if cog:
                cog._state(interaction.guild_id).clear()
            await interaction.response.send_message(
                embed=Embed(description="🛑 Stopped.", color=COLORS["red"]), ephemeral=True)
        else:
            await interaction.response.send_message(
                embed=Embed(description="Not in a voice channel.", color=COLORS["grey"]), ephemeral=True)


# ── Idle music view ───────────────────────────────────────────────────────────
class IdleControlView(View):
    def __init__(self, cog: "MusicCog" = None, vc: discord.VoiceClient = None, guild_id: int = 0, *, timeout: float | None = None):
        super().__init__(timeout=timeout)
        self.cog      = cog
        self.vc       = vc
        self.guild_id = guild_id

    def _get_vc(self, interaction: discord.Interaction) -> discord.VoiceClient | None:
        """Return stored vc if still connected, else fall back to guild voice client."""
        if self.vc and self.vc.is_connected():
            return self.vc
        return interaction.guild.voice_client

    def _get_cog(self, interaction: discord.Interaction) -> "MusicCog | None":
        return self.cog or interaction.client.cogs.get("Music")

    @discord.ui.button(emoji="⏸", label="Pause",  style=discord.ButtonStyle.primary,  custom_id="idle_pause")
    async def _pause(self, interaction: discord.Interaction, _: Button):
        vc = self._get_vc(interaction)
        if vc and vc.is_playing():
            vc.pause()
            await interaction.response.send_message(
                embed=Embed(description="⏸ Paused.", color=COLORS["blue"]), ephemeral=True)
        else:
            await interaction.response.send_message(
                embed=Embed(description="Nothing is playing.", color=COLORS["grey"]), ephemeral=True)

    @discord.ui.button(emoji="▶", label="Resume", style=discord.ButtonStyle.success,  custom_id="idle_resume")
    async def _resume(self, interaction: discord.Interaction, _: Button):
        vc = self._get_vc(interaction)
        if vc and vc.is_paused():
            vc.resume()
            await interaction.response.send_message(
                embed=Embed(description="▶ Resumed.", color=COLORS["green"]), ephemeral=True)
        else:
            await interaction.response.send_message(
                embed=Embed(description="Not paused.", color=COLORS["grey"]), ephemeral=True)

    @discord.ui.button(emoji="🛑", label="Stop",  style=discord.ButtonStyle.danger,   custom_id="idle_stop")
    async def _stop(self, interaction: discord.Interaction, _: Button):
        vc = self._get_vc(interaction)
        if vc:
            vc.stop()
        cog = self._get_cog(interaction)
        if cog:
            cog._state(interaction.guild_id).now_playing = None
        await interaction.response.send_message(
            embed=Embed(description="🛑 Stopped.", color=COLORS["red"]), ephemeral=True)


# ── Cog ───────────────────────────────────────────────────────────────────────
class MusicCog(commands.Cog, name="Music"):
    def __init__(self, bot: commands.Bot):
        self.bot          = bot
        self._guild_states: dict[int, GuildState] = {}
        # Register persistent views so buttons work after bot restart
        bot.add_view(MusicControlView())
        bot.add_view(IdleControlView())

    def _state(self, guild_id: int) -> GuildState:
        """Get or create per-guild state."""
        if guild_id not in self._guild_states:
            self._guild_states[guild_id] = GuildState()
        return self._guild_states[guild_id]

    @commands.Cog.listener()
    async def on_guild_remove(self, guild: discord.Guild):
        """Clean up state when bot leaves a guild."""
        self._guild_states.pop(guild.id, None)

    # ── private helpers ───────────────────────────────────────────────────────

    async def _connect(self, ctx: commands.Context) -> discord.VoiceClient | None:
        if not ctx.author.voice:
            return None
        vc = ctx.guild.voice_client
        if vc:
            return vc
        try:
            vc = await ctx.author.voice.channel.connect(timeout=10.0, reconnect=True)
            await asyncio.sleep(0.3)
            return vc
        except Exception as e:
            log.error("Voice connect: %s", e)
            return None

    async def _search(self, query: str) -> dict | None:
        """Search for a song using flat extraction for speed, returns info dict."""
        q    = _resolve_query(query)
        opts = {**_YTDL_OPTS, "extract_flat": True}
        def _do():
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(f"ytsearch:{q}", download=False)
        try:
            res     = await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(None, _do), timeout=15)
            entries = res.get("entries") if res else None
            if not entries:
                return None
            entry = entries[0]
            url   = entry.get("webpage_url") or entry.get("url")
            if not url:
                return None
            return {
                "url":       url,
                "title":     entry.get("title", "Unknown"),
                "thumbnail": entry.get("thumbnail", ""),
                "duration":  entry.get("duration", 0) or 0,
            }
        except Exception as e:
            log.error("Search error: %s", e)
            return None

    async def _play_next(self, ctx: commands.Context, _depth: int = 0):
        """Play the next song in queue. _depth prevents unbounded recursion on errors."""
        if _depth > 5:
            log.error("_play_next: too many consecutive failures, stopping.")
            return

        st = self._state(ctx.guild.id)
        vc = ctx.guild.voice_client
        if not vc:
            st.clear()
            return

        if st.loop_mode and st.now_playing:
            song = {
                "url":       st.now_playing.webpage_url or st.now_playing.url,
                "title":     st.now_playing.title,
                "thumbnail": st.now_playing.thumbnail,
                "duration":  st.now_playing.duration,
            }
        elif st.queue:
            song = st.queue.popleft()
        else:
            st.now_playing = None
            return

        try:
            player         = await YTDLSource.from_url(song["url"])
            import time as _time
            st.now_playing = player
            st.play_start  = _time.time()
            loop           = asyncio.get_running_loop()
            def _after(err):
                if err:
                    log.error("Playback error: %s", err)
                asyncio.run_coroutine_threadsafe(self._play_next(ctx), loop)
            vc.play(player, after=_after)
            embed = Embed(description=f"🎵 Now playing: **{player.title}**", color=COLORS["green"])
            embed.add_field(name="Duration", value=YTDLSource.fmt_duration(player.duration), inline=True)
            if st.loop_mode:
                embed.add_field(name="Loop", value="🔁 On", inline=True)
            if player.thumbnail:
                embed.set_thumbnail(url=player.thumbnail)
            await ctx.channel.send(embed=embed)
        except Exception as e:
            log.error("_play_next error: %s", e)
            st.now_playing = None
            if st.queue:
                log.info("Skipping failed song, trying next (depth=%d)...", _depth)
                await self._play_next(ctx, _depth=_depth + 1)

    def _np_embed(self, st: GuildState) -> Embed:
        p     = st.now_playing
        embed = Embed(title="🎵 Now Playing", description=f"**{p.title[:256]}**", color=COLORS["green"])
        embed.add_field(name="Duration", value=YTDLSource.fmt_duration(p.duration), inline=True)
        embed.add_field(name="Loop",     value="🔁 On" if st.loop_mode else "Off", inline=True)
        if p.webpage_url:
            embed.add_field(name="Link", value=f"[Open]({p.webpage_url})", inline=True)
        if p.thumbnail:
            embed.set_thumbnail(url=p.thumbnail)
        return embed

    # ── /join ─────────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="join", description="Join your voice channel.")
    @commands.cooldown(1, 5, commands.BucketType.user)
    async def join(self, ctx: commands.Context):
        if ctx.guild.voice_client:
            return await ctx.send(embed=Embed(
                description="🎤 Already in a voice channel!", color=COLORS["orange"]), ephemeral=True)
        if not ctx.author.voice:
            return await ctx.send(embed=Embed(
                description="🎤 Join a voice channel first!", color=COLORS["red"]), ephemeral=True)
        vc = await self._connect(ctx)
        if vc:
            await ctx.send(embed=Embed(
                description=f"🎤 Joined **{vc.channel.name}**!", color=COLORS["green"]), ephemeral=True)
        else:
            await ctx.send(embed=Embed(
                description="❌ Could not connect to voice channel!", color=COLORS["red"]), ephemeral=True)

    # ── /leave ────────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="leave", description="Leave the voice channel.")
    @commands.cooldown(1, 5, commands.BucketType.user)
    async def leave(self, ctx: commands.Context):
        vc = ctx.guild.voice_client
        if not vc:
            return await ctx.send(embed=Embed(
                description="🎤 Not in a voice channel!", color=COLORS["red"]), ephemeral=True)
        self._state(ctx.guild.id).clear()
        await vc.disconnect()
        await ctx.send(embed=Embed(description="👋 Disconnected!", color=COLORS["green"]), ephemeral=True)

    # ── /play ─────────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="play", aliases=["p"], description="Play a song from YouTube or Spotify.")
    @app_commands.describe(query="Song name, YouTube URL, or Spotify track URL")
    @commands.cooldown(1, 3, commands.BucketType.user)
    async def play(self, ctx: commands.Context, *, query: str):
        if not ctx.author.voice:
            return await ctx.send(embed=Embed(
                description="🎤 Join a voice channel first!", color=COLORS["red"]), delete_after=8)
        await ctx.defer()
        vc = await self._connect(ctx)
        if not vc:
            return await ctx.send(embed=Embed(
                description="❌ Could not connect to voice!", color=COLORS["red"]), delete_after=8)
        song = await self._search(query)
        if not song:
            return await ctx.send(embed=Embed(
                description=f"❌ No results for `{query}`.", color=COLORS["red"]), delete_after=8)

        st = self._state(ctx.guild.id)
        async with st.play_lock:
            if vc.is_playing() or vc.is_paused():
                st.queue.append(song)
                embed = Embed(
                    description=f"➕ Added **#{len(st.queue)}** in queue: **{song['title']}**",
                    color=COLORS["orange"])
                embed.add_field(name="Duration", value=YTDLSource.fmt_duration(song["duration"]), inline=True)
                if song["thumbnail"]:
                    embed.set_thumbnail(url=song["thumbnail"])
                await ctx.send(embed=embed)
            else:
                try:
                    player         = await YTDLSource.from_url(song["url"])
                    import time as _time
                    st.now_playing = player
                    st.play_start  = _time.time()
                    loop           = asyncio.get_running_loop()
                    def _after(err):
                        if err:
                            log.error("Playback error: %s", err)
                        asyncio.run_coroutine_threadsafe(self._play_next(ctx), loop)
                    vc.play(player, after=_after)
                    embed = Embed(description=f"🎵 Playing: **{player.title}**", color=COLORS["green"])
                    embed.add_field(name="Duration", value=YTDLSource.fmt_duration(player.duration), inline=True)
                    if player.thumbnail:
                        embed.set_thumbnail(url=player.thumbnail)
                    await ctx.send(embed=embed, view=MusicControlView(self, ctx.guild.id, timeout=7200))
                except Exception as e:
                    log.error("play error: %s", e)
                    await ctx.send(embed=Embed(
                        description=f"❌ Failed to play: `{e}`", color=COLORS["red"]), delete_after=10)

        log_action(ctx.guild.name, str(ctx.author), ctx.channel.name, "Play",
                   [_entry(ctx.author, f"play {query}")])

    # ── /pause ────────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="pause", description="Pause the current song.")
    async def pause(self, ctx: commands.Context):
        vc = ctx.guild.voice_client
        if vc and vc.is_playing():
            vc.pause()
            await ctx.send(embed=Embed(description="⏸️ Paused.", color=COLORS["blue"]))
        else:
            await ctx.send(embed=Embed(
                description="Nothing is playing.", color=COLORS["grey"]), delete_after=6)

    # ── /resume ───────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="resume", description="Resume the paused song.")
    async def resume(self, ctx: commands.Context):
        vc = ctx.guild.voice_client
        if vc and vc.is_paused():
            vc.resume()
            await ctx.send(embed=Embed(description="▶️ Resumed.", color=COLORS["green"]))
        else:
            await ctx.send(embed=Embed(
                description="Nothing is paused.", color=COLORS["grey"]), delete_after=6)

    # ── /skip ─────────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="skip", aliases=["sk"], description="Skip the current song.")
    @commands.cooldown(1, 3, commands.BucketType.user)
    async def skip(self, ctx: commands.Context):
        vc = ctx.guild.voice_client
        if not vc or (not vc.is_playing() and not vc.is_paused()):
            return await ctx.send(embed=Embed(
                description="🎶 Nothing to skip!", color=COLORS["grey"]), delete_after=8)
        st    = self._state(ctx.guild.id)
        title = st.now_playing.title if st.now_playing else "?"
        vc.stop()
        await ctx.send(embed=Embed(
            description=f"⏭️ Skipped **{title}**.", color=COLORS["green"]), delete_after=10)
        log_action(ctx.guild.name, str(ctx.author), ctx.channel.name, "Skip",
                   [_entry(ctx.author, "skip")])

    # ── /stop ─────────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="stop", description="Stop music and clear the queue.")
    @commands.cooldown(1, 5, commands.BucketType.user)
    async def stop(self, ctx: commands.Context):
        vc = ctx.guild.voice_client
        if not vc:
            return await ctx.send(embed=Embed(
                description="🎤 Not in a voice channel!", color=COLORS["red"]), delete_after=8)
        vc.stop()
        self._state(ctx.guild.id).clear()
        await ctx.send(embed=Embed(description="🛑 Stopped & queue cleared.", color=COLORS["red"]))
        log_action(ctx.guild.name, str(ctx.author), ctx.channel.name, "Stop",
                   [_entry(ctx.author, "stop")])

    # ── /remove ───────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="remove", description="Remove a song from the queue by position.")
    @app_commands.describe(position="Position in queue (1 = next)")
    async def remove(self, ctx: commands.Context, position: int):
        st = self._state(ctx.guild.id)
        if not st.queue:
            return await ctx.send(embed=Embed(
                description="🎶 The queue is empty!", color=COLORS["grey"]), delete_after=8)
        if not 1 <= position <= len(st.queue):
            return await ctx.send(embed=Embed(
                description=f"❌ Position must be **1 – {len(st.queue)}**.",
                color=COLORS["red"]), delete_after=8)
        removed = st.queue[position - 1]
        del st.queue[position - 1]
        await ctx.send(embed=Embed(
            description=f"🗑️ Removed **{removed['title']}** from position #{position}.",
            color=COLORS["green"]))

    # ── /queue ────────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="queue", aliases=["q"], description="Show the music queue.")
    async def queue_cmd(self, ctx: commands.Context):
        st = self._state(ctx.guild.id)
        if not st.queue and not st.now_playing:
            return await ctx.send(embed=Embed(
                description="🎶 The queue is empty!", color=COLORS["grey"]), delete_after=8)
        embed = Embed(title="🎵 Music Queue", color=COLORS["blue"])
        if st.now_playing:
            dur  = YTDLSource.fmt_duration(st.now_playing.duration)
            icon = " 🔁" if st.loop_mode else ""
            embed.add_field(
                name=f"▶ Now Playing{icon}",
                value=f"**{st.now_playing.title}** `[{dur}]`",
                inline=False)
        if st.queue:
            lines = [
                f"`{i+1}.` **{s['title']}** `[{YTDLSource.fmt_duration(s['duration'])}]`"
                for i, s in enumerate(list(st.queue)[:20])
            ]
            if len(st.queue) > 20:
                lines.append(f"*… and {len(st.queue) - 20} more*")
            embed.add_field(
                name=f"⏭ Up Next ({len(st.queue)} songs)",
                value="\n".join(lines),
                inline=False)
        await ctx.send(embed=embed)

    # ── /nowplaying ───────────────────────────────────────────────────────────
    @commands.hybrid_command(name="nowplaying", aliases=["np"], description="Show the current song.")
    async def nowplaying(self, ctx: commands.Context):
        st = self._state(ctx.guild.id)
        vc = ctx.guild.voice_client
        if not st.now_playing or not vc:
            return await ctx.send(embed=Embed(
                description="🎶 Nothing is playing!", color=COLORS["grey"]), delete_after=8)
        await ctx.send(embed=self._np_embed(st))

    # ── /volume ───────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="volume", description="Set volume (0 – 100).")
    @app_commands.describe(level="Volume level 0 – 100")
    @commands.cooldown(1, 3, commands.BucketType.user)
    async def volume(self, ctx: commands.Context, level: int):
        vc = ctx.guild.voice_client
        if not vc:
            return await ctx.send(embed=Embed(
                description="Not in a voice channel.", color=COLORS["red"]), delete_after=6)
        if not 0 <= level <= 100:
            return await ctx.send(embed=Embed(
                description="Volume must be **0 – 100**.", color=COLORS["red"]), delete_after=6)
        if not vc.source:
            return await ctx.send(embed=Embed(
                description="Nothing is playing.", color=COLORS["grey"]), delete_after=6)
        vc.source.volume = level / 100
        icon = "🔇" if level == 0 else ("🔉" if level < 50 else "🔊")
        await ctx.send(embed=Embed(
            description=f"{icon} Volume → **{level}%**", color=COLORS["green"]))

    # ── /shuffle ──────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="shuffle", description="Shuffle the queue.")
    async def shuffle(self, ctx: commands.Context):
        st = self._state(ctx.guild.id)
        if len(st.queue) < 2:
            return await ctx.send(embed=Embed(
                description="Need at least **2 songs** in the queue to shuffle.",
                color=COLORS["orange"]), delete_after=6)
        items = list(st.queue)
        random.shuffle(items)
        st.queue = deque(items)
        await ctx.send(embed=Embed(
            description=f"🔀 Shuffled **{len(st.queue)}** songs.", color=COLORS["green"]))

    # ── /loop ─────────────────────────────────────────────────────────────────
    @commands.hybrid_command(name="loop", description="Toggle loop for the current song.")
    async def loop(self, ctx: commands.Context):
        st           = self._state(ctx.guild.id)
        st.loop_mode = not st.loop_mode
        state        = "🔁 **Enabled**" if st.loop_mode else "**Disabled**"
        await ctx.send(embed=Embed(description=f"Loop: {state}", color=COLORS["green"]))

    # ── /idlemusic ────────────────────────────────────────────────────────────
    _IDLE_URL = "https://www.youtube.com/watch?v=jfKfPfyJRdk"

    @commands.hybrid_command(name="idlemusic", description="Play Lo-Fi idle music.")
    @commands.cooldown(1, 5, commands.BucketType.user)
    async def idlemusic(self, ctx: commands.Context):
        url = self._IDLE_URL
        if not ctx.author.voice:
            return await ctx.send(embed=Embed(
                description="🎤 Join a voice channel first!", color=COLORS["red"]), delete_after=8)
        await ctx.defer()
        vc = await self._connect(ctx)
        if not vc:
            return await ctx.send(embed=Embed(
                description="❌ Could not connect!", color=COLORS["red"]))
        try:
            source = await YTDLSource.from_url(url)
            if vc.is_playing():
                vc.stop()
            vc.play(source)
            import time as _time
            st             = self._state(ctx.guild.id)
            st.now_playing = source
            st.play_start  = _time.time()
            st.queue.clear()
            short = source.title[:28] + ("…" if len(source.title) > 28 else "")
            embed = Embed(description=f"🎶 Idle music: **{short}**", color=COLORS["purple"])
            if source.thumbnail:
                embed.set_thumbnail(url=source.thumbnail)
            await ctx.send(embed=embed, view=IdleControlView(self, vc, ctx.guild.id))
        except Exception as e:
            log.error("idlemusic error: %s", e)
            await ctx.send(embed=Embed(description=f"❌ Error: `{e}`", color=COLORS["red"]))


async def setup(bot: commands.Bot):
    await bot.add_cog(MusicCog(bot))
