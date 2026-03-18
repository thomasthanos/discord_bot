"""
src/cogs/help.py — Interactive paginated help menu.
"""
import logging

import discord
from discord import Embed
from discord.ext import commands
from discord.ui import Button, View

from src.config import COLORS
from src.cogs.moderation import _entry, log_action

log = logging.getLogger(__name__)

_PAGES = {
    "home": {
        "title": "🤖 Bot Help",
        "color": "purple",
        "desc":  (
            "Navigate with the buttons below.\n"
            "Every command works as `!cmd` **and** `/cmd`.\n\n"
            "**📦 Categories**\n"
            "🔧 Moderation • 🎵 Music • 📩 Invite"
        ),
        "fields": [],
    },
    "moderation": {
        "title": "🔧 Moderation",
        "color": "red",
        "desc":  None,
        "fields": [
            ("!clear [n]",            "Delete N messages.  Alias `!c`"),
            ("!wipe",                 "Wipe **all** messages (confirmation).  `!w`"),
            ("!addwipeuser [id]",     "Add user to wipe whitelist.  `!aw`"),
            ("!removewipeuser [id]",  "Remove user from wipe whitelist.  `!rw`"),
            ("!wipeusers",            "List the wipe whitelist."),
            ("!logs",                 "Open web log panel in browser.  `!viewlogs`"),
        ],
    },
    "music": {
        "title": "🎵 Music",
        "color": "blue",
        "desc":  "YouTube URLs, search terms, and Spotify track links all work.",
        "fields": [
            ("!join",             "Join your voice channel."),
            ("!leave",            "Leave the voice channel."),
            ("!play [query]",     "Play a song or add to queue.  `!p`"),
            ("!pause",            "Pause playback."),
            ("!resume",           "Resume playback."),
            ("!skip",             "Skip the current song.  `!sk`"),
            ("!stop",             "Stop & clear the queue."),
            ("!remove [pos]",     "Remove song at position from queue."),
            ("!queue",            "Show the queue.  `!q`"),
            ("!nowplaying",       "Show the current song.  `!np`"),
            ("!volume [0–100]",   "Set the volume."),
            ("!shuffle",          "Shuffle the queue."),
            ("!loop",             "Toggle loop for the current song."),
            ("!idlemusic [url]",  "Play Lo-Fi idle music."),
        ],
    },
    "invite": {
        "title": "📩 Invite",
        "color": "green",
        "desc":  "Automatically tracks who invited each member.",
        "fields": [
            ("!setinvitechannel [#ch]",         "Set the invite log channel (admin)."),
            ("!invitestats [@user]",             "Show invite stats for a member."),
            ("!topinviters [n]",                "Top-n inviters leaderboard."),
            ("!addinvitelog [@m] [@inv] [code]", "Manually log an invite (admin)."),
        ],
    },
}

_ORDER = ["home", "moderation", "music", "invite"]
_EMOJI = {"home": "🏠", "moderation": "🔧", "music": "🎵", "invite": "📩"}


def _build_embed(page: str) -> Embed:
    data  = _PAGES[page]
    embed = Embed(title=data["title"], color=COLORS[data["color"]])
    if data["desc"]:
        embed.description = data["desc"]
    for name, val in data["fields"]:
        embed.add_field(name=f"`{name}`", value=val, inline=False)
    embed.set_footer(text="prefix: !   •   slash: /")
    return embed


class HelpView(View):
    def __init__(self, owner_id: int):
        super().__init__(timeout=120)
        self.owner_id = owner_id
        self.page     = "home"
        self._msg: discord.Message | None = None
        self._rebuild()

    def _rebuild(self) -> None:
        self.clear_items()
        for key in _ORDER:
            btn = Button(
                label=f"{_EMOJI[key]} {key.capitalize()}",
                style=(discord.ButtonStyle.primary
                       if key == self.page
                       else discord.ButtonStyle.secondary),
                custom_id=f"help_{key}",
            )
            btn.callback = self._make_cb(key)
            self.add_item(btn)

    def _make_cb(self, key: str):
        async def _cb(interaction: discord.Interaction):
            if interaction.user.id != self.owner_id:
                return await interaction.response.send_message(
                    "❌ This menu isn't yours.", ephemeral=True)
            self.page = key
            self._rebuild()
            await interaction.response.edit_message(embed=_build_embed(key), view=self)
        return _cb

    async def on_timeout(self) -> None:
        for item in self.children:
            item.disabled = True
        if self._msg:
            try:
                await self._msg.edit(view=self)
            except Exception:
                pass


class HelpCog(commands.Cog, name="Help"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.hybrid_command(name="help", description="Show all bot commands.")
    async def help(self, ctx: commands.Context):
        view  = HelpView(ctx.author.id)
        embed = _build_embed("home")

        if ctx.interaction:
            await ctx.interaction.response.send_message(embed=embed, view=view)
            view._msg = await ctx.interaction.original_response()
        else:
            view._msg = await ctx.send(embed=embed, view=view)

        log_action(
            ctx.guild.name if ctx.guild else "DM",
            str(ctx.author),
            ctx.channel.name if hasattr(ctx.channel, "name") else "DM",
            "Help",
            [_entry(ctx.author, "help")],
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(HelpCog(bot))
